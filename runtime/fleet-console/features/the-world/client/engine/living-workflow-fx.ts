import {
  AdditiveBlending,
  BoxGeometry,
  Color,
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
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";

import { PLUSH_VIVID_TONES } from "../../../workspace/shared/mongle-3d-glsl.js";
import type { WorldActorSpec, WorldVillageSpec } from "../../shared/world-types.js";

/**
 * 「더 월드」 리빙 워크플로우 3D 비주얼 엔진 (60fps zero-GC 풀링).
 *
 * 1. 긴급 별빛 비콘 기둥 (Urgent Golden Aurora Pillars): 대기 질문/확인이 필요한 사령관 마을 위로 22m 황금 오로라 빛기둥.
 * 2. 별빛 전령 구슬 (Starlight Courier Orbs): 사령관 ↔ 지휘관 ↔ 구성원 간 실시간 활동 흐름을 2차 베지어 포물선 빛구슬 + 별꼬리로 시각화.
 * 3. 마을 목표 진행 별빛 크리스탈 (Objective Progress Crystal): 목표가 있는 마을 광장 상공 회전 팔면체 크리스탈(진행도 0..1 반영 + 완료 황금 플래시).
 * 4. 하늘 순찰 황금 링 · 실시간 작업 공방 홀로그램/불꽃 · 완료 3D 불꽃놀이 · 3D 작전 깃발(웨이포인트) & 출동 궤적.
 */

export interface LivingWorkflowPoint {
  readonly x: number;
  readonly z: number;
  readonly y?: number | undefined;
}

export interface SkyRingPassResult {
  readonly ringIndex: number;
  /** 기존 호환 필드 (`comboCount`와 동일). */
  readonly combo: number;
  readonly comboCount: number;
  readonly boostTrigger: boolean;
}

export interface SkyRingPositionOut {
  x: number;
  y: number;
  z: number;
  distM: number;
}

export interface WorkingVillageFxInput {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly accentHex: number;
}

export interface OperationFlagFxInput {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly originX?: number | undefined;
  readonly originZ?: number | undefined;
  readonly accentHex?: number | undefined;
}

export interface LivingWorkflowFx {
  /** 두 지점 사이로 포물선(2차 베지어) 별빛 전령 구슬을 발사한다. */
  spawnCourier(from: LivingWorkflowPoint, to: LivingWorkflowPoint, colorHex?: number): void;
  /** 하늘 순찰 황금 별빛 링 8기의 가시성을 전환한다 (`overviewMode` 비행 중에만 표시). */
  setSkyRingsVisible(visible: boolean): void;
  /** 비행 중 플레이어 좌표가 8개 별빛 링 중 하나를 통과했는지 판정한다 (6초 쿨다운 + 황금 버스트 + 12초 콤보 1..8). */
  checkSkyRingPass(px: number, py: number, pz: number, isFlying: boolean): SkyRingPassResult | null;
  /** 하늘 순찰 링 연속 통과 콤보를 초기화한다 (착지 시 리셋용). */
  resetSkyRingCombo(): void;
  /** 쿨다운이 아닌 가장 가까운 다음 하늘 순찰 링의 3D 좌표와 거리를 0-GC로 조회한다. */
  getNearestReadySkyRing(px: number, py: number, pz: number, out: SkyRingPositionOut): boolean;
  /** 현재 작업 중인 사령관 마을 상공의 별빛 설계도 홀로그램 링 + 공방 불꽃을 동기화한다. */
  syncWorkingVillages(villages: readonly WorkingVillageFxInput[]): void;
  /** 목표 완료 시 지브리풍 황금 유성 상승 + 파스텔/황금 별빛 꽃불 3D 축포를 발사한다 (최대 3발 동시 풀링). */
  triggerVillageFirework(x: number, z: number, accentHex?: number): void;
  /** 3D 작전 깃발(웨이포인트)과 사령관 출동 별빛 궤적을 배치하거나(`null`로) 즉시 해제한다. */
  setOperationFlag(flag: OperationFlagFxInput | null): void;
  /** 두 마을 사이를 잇는 빛나는 포물선 합동 작전 별빛 아치를 6.5초간 연출한다. */
  spawnJointMissionArch(fromX: number, fromZ: number, toX: number, toZ: number, colorHex?: number): void;
  /** 매 프레임 리빙 워크플로우 FX를 갱신한다 (비활성 FX는 visible=false로 Draw Call 0 유지). */
  update(
    dt: number,
    elapsed: number,
    villages: readonly WorldVillageSpec[],
    actors: readonly WorldActorSpec[],
  ): void;
  dispose(): void;
}

const MAX_PILLARS = 12;
const MAX_COURIERS = 24;
const MAX_TRAIL_BEADS = 160;
const MAX_CRYSTALS = 16;
const SKY_RING_COUNT = 8;
const SKY_RING_RUNES_PER_RING = 4;
const SKY_RING_TOTAL_RUNES = SKY_RING_COUNT * SKY_RING_RUNES_PER_RING;
const SKY_RING_COOLDOWN_SEC = 6.0;
const SKY_RING_COMBO_WINDOW_SEC = 12.0;
const MAX_JOINT_ARCHES = 4;
const ARCH_SEGMENTS = 28;
const MAX_ARCH_INSTANCES = MAX_JOINT_ARCHES * ARCH_SEGMENTS;
const JOINT_ARCH_DURATION_SEC = 6.5;
const MAX_MAILBOX_CRESTS = 16;
const MAX_WORKING_VILLAGES = 12;
const WORK_SPARKS_PER_VILLAGE = 5;
const MAX_WORK_SPARKS = MAX_WORKING_VILLAGES * WORK_SPARKS_PER_VILLAGE;
const MAX_FIREWORKS = 3;
const FW_SPARKS_PER_SHELL = 34;
const MAX_FW_SPARKS = MAX_FIREWORKS * FW_SPARKS_PER_SHELL;
const FW_ASCENT_SEC = 0.78;
const FW_BURST_SEC = 2.15;
const OP_TRAJ_COUNT = 22;

const AURORA_PILLAR_VERTEX = /* glsl */ `
out vec2 vUv;
out vec3 vNormalView;
out vec3 vViewDir;

void main() {
  vUv = uv;
  #ifdef USE_INSTANCING
    mat4 mv = modelViewMatrix * instanceMatrix;
    vec4 mvPos = mv * vec4(position, 1.0);
    vNormalView = normalize(mat3(mv) * normal);
  #else
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
  #endif
  vViewDir = normalize(-mvPos.xyz);
  gl_Position = projectionMatrix * mvPos;
}
`;

const AURORA_PILLAR_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uCoreBoost;
in vec2 vUv;
in vec3 vNormalView;
in vec3 vViewDir;
out vec4 fragColor;

void main() {
  float h = clamp(vUv.y, 0.0, 1.0);
  // 하단 부드러운 접지 진입 + 상단 22m까지 은은하게 소멸
  float verticalFade = smoothstep(0.0, 0.07, h) * pow(1.0 - h, 1.48);

  // 부드럽게 솟아오르는 황금 오로라 물결 리본
  float angle = vUv.x * 6.2831853;
  float ribbon1 = 0.55 + 0.45 * sin(angle * 3.0 + h * 7.5 - uTime * 2.4);
  float ribbon2 = 0.60 + 0.40 * sin(angle * 5.0 - h * 11.0 - uTime * 3.6);
  float shimmer = mix(ribbon1, ribbon1 * ribbon2, 0.45);

  // 실린더 가장자리 부드러운 프레넬 페이드 (각진 경계 제거)
  float ndv = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float edgeSoft = pow(clamp(ndv, 0.0, 1.0), mix(1.25, 0.72, uCoreBoost));

  vec3 goldLow = vec3(1.0, 0.76, 0.24);
  vec3 goldHigh = vec3(1.0, 0.96, 0.76);
  vec3 col = mix(goldLow, goldHigh, clamp(h * 0.65 + uCoreBoost * 0.35 + shimmer * 0.2, 0.0, 1.0));

  float pulse = 0.86 + 0.14 * sin(uTime * 3.1 + h * 4.0);
  float alpha = verticalFade * edgeSoft * (0.28 + 0.34 * shimmer) * pulse * mix(0.68, 1.05, uCoreBoost);
  if (alpha < 0.005) discard;

  fragColor = vec4(col * (1.05 + uCoreBoost * 0.45), clamp(alpha, 0.0, 0.92));
}
`;

const SKY_RING_VERTEX = /* glsl */ `
out vec2 vUv;
out vec3 vNormalView;
out vec3 vViewDir;
out vec3 vInstColor;

void main() {
  vUv = uv;
  #ifdef USE_INSTANCING
    mat4 mv = modelViewMatrix * instanceMatrix;
    vec4 mvPos = mv * vec4(position, 1.0);
    vNormalView = normalize(mat3(mv) * normal);
  #else
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
  #endif
  #ifdef USE_INSTANCING_COLOR
    vInstColor = instanceColor;
  #else
    vInstColor = vec3(1.0, 0.88, 0.35);
  #endif
  vViewDir = normalize(-mvPos.xyz);
  gl_Position = projectionMatrix * mvPos;
}
`;

const SKY_RING_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uCorePass;
in vec2 vUv;
in vec3 vNormalView;
in vec3 vViewDir;
in vec3 vInstColor;
out vec4 fragColor;

void main() {
  // 토러스 둘레를 따라 회전하는 황금 쉐브론 에너지 파동 + 미세 별빛 스파클 (과포화 블룸 억제)
  float ang = vUv.x * 6.2831853;
  float tube = abs(vUv.y - 0.5) * 2.0;
  float speed = mix(3.8, -6.0, uCorePass);
  float chevron = 0.5 + 0.5 * sin(ang * 8.0 - uTime * speed + tube * 5.2);
  float chevronSharp = smoothstep(0.32, 0.94, chevron);
  float sparkle = pow(0.5 + 0.5 * sin(ang * 16.0 + uTime * 5.8), 4.5);

  // 시선각 기반 프레넬 테두리 + 따뜻한 앰버-골드 코어 (흰색 날림 방지)
  float ndv = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float fresnel = pow(1.0 - clamp(ndv, 0.0, 1.0), 1.75);
  float coreBand = pow(clamp(ndv, 0.0, 1.0), 0.85);

  vec3 amberCore = vec3(0.96, 0.64, 0.14);
  vec3 warmGold = vec3(1.0, 0.86, 0.42);
  vec3 baseCol = mix(amberCore, vInstColor, 0.68);
  vec3 col = mix(baseCol, warmGold, clamp(chevronSharp * 0.34 + fresnel * 0.42 + sparkle * 0.24 + uCorePass * 0.16, 0.0, 0.72));
  col *= (0.64 + chevronSharp * 0.34 + fresnel * 0.36 + sparkle * 0.18);
  col = min(col, vec3(1.02, 0.88, 0.56));

  float alpha = mix(0.38, 0.78, clamp(coreBand * 0.58 + chevronSharp * 0.36 + fresnel * 0.44, 0.0, 1.0));
  alpha *= mix(0.78, 0.84, uCorePass);
  if (alpha < 0.01) discard;
  fragColor = vec4(col, alpha);
}
`;

const WORK_HOLO_VERTEX = /* glsl */ `
out vec2 vUv;
out vec3 vNormalView;
out vec3 vViewDir;
out vec3 vInstColor;

void main() {
  vUv = uv;
  #ifdef USE_INSTANCING
    mat4 mv = modelViewMatrix * instanceMatrix;
    vec4 mvPos = mv * vec4(position, 1.0);
    vNormalView = normalize(mat3(mv) * normal);
  #else
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
  #endif
  #ifdef USE_INSTANCING_COLOR
    vInstColor = instanceColor;
  #else
    vInstColor = vec3(1.0, 0.82, 0.32);
  #endif
  vViewDir = normalize(-mvPos.xyz);
  gl_Position = projectionMatrix * mvPos;
}
`;

const WORK_HOLO_FRAGMENT = /* glsl */ `
uniform float uTime;
in vec2 vUv;
in vec3 vNormalView;
in vec3 vViewDir;
in vec3 vInstColor;
out vec4 fragColor;

void main() {
  // 별빛 설계도 점선 아크 + 미세 눈금 펄스
  float ang = vUv.x * 6.2831853;
  float dash = smoothstep(0.12, 0.45, 0.5 + 0.5 * sin(ang * 10.0 - uTime * 2.4));
  float ticks = smoothstep(0.65, 0.96, 0.5 + 0.5 * sin(ang * 30.0 + uTime * 1.4));
  float pulse = 0.78 + 0.22 * sin(uTime * 3.2 + ang * 2.0);
  float ndv = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float edge = mix(0.55, 1.0, pow(1.0 - clamp(ndv, 0.0, 1.0), 1.2));

  vec3 goldTint = vec3(1.0, 0.86, 0.42);
  vec3 col = mix(vInstColor, goldTint, 0.45 + ticks * 0.35) * pulse;
  col = min(col, vec3(1.0, 0.90, 0.60));
  float alpha = (0.28 + dash * 0.44 + ticks * 0.22) * edge * 0.72;
  if (alpha < 0.01) discard;
  fragColor = vec4(col, alpha);
}
`;

const OP_FLAG_VERTEX = /* glsl */ `
uniform float uTime;
out vec2 vUv;

void main() {
  vUv = uv;
  vec3 pos = position;
  float pin = smoothstep(0.0, 0.16, uv.x);
  float wave1 = sin(uv.x * 5.8 - uTime * 5.4 + uv.y * 1.8) * 0.11 * pin;
  float wave2 = cos(uv.x * 11.2 - uTime * 8.2) * 0.032 * pin * uv.x;
  pos.z += wave1 + wave2;
  pos.y += sin(uv.x * 4.2 - uTime * 4.4) * 0.035 * pin;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const OP_FLAG_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uAccentColor;
in vec2 vUv;
out vec4 fragColor;

void main() {
  // 테이퍼형 제비꼬리 페넌트 실루엣 마스킹
  float halfH = mix(0.50, 0.18, vUv.x);
  float dy = abs(vUv.y - 0.5);
  if (dy > halfH) discard;
  // 끝단 V자 제비꼬리 홈
  if (vUv.x > 0.80) {
    float notch = (vUv.x - 0.80) / 0.20 * 0.15;
    if (dy < notch) discard;
  }

  float borderDist = halfH - dy;
  float trim = 1.0 - smoothstep(0.025, 0.055, borderDist);
  float leftTrim = 1.0 - smoothstep(0.03, 0.07, vUv.x);
  float goldBorder = max(trim, leftTrim);

  // 중앙 4각 별빛 문양
  vec2 sp = vec2((vUv.x - 0.34) * 1.55, vUv.y - 0.5);
  float starCross = max(
    (1.0 - smoothstep(0.015, 0.042, abs(sp.x))) * (1.0 - smoothstep(0.06, 0.16, abs(sp.y))),
    (1.0 - smoothstep(0.015, 0.042, abs(sp.y))) * (1.0 - smoothstep(0.06, 0.16, abs(sp.x)))
  );
  float starCore = 1.0 - smoothstep(0.035, 0.075, length(sp));
  float starMask = clamp(max(starCross, starCore), 0.0, 1.0);

  float shimmer = 0.88 + 0.12 * sin(vUv.x * 7.0 - uTime * 4.5);
  vec3 bannerBase = mix(uAccentColor, vec3(0.98, 0.72, 0.18), 0.42) * shimmer;
  vec3 goldCol = vec3(1.0, 0.90, 0.48);
  vec3 col = mix(bannerBase, goldCol, clamp(goldBorder * 0.85 + starMask * 0.95, 0.0, 1.0));
  fragColor = vec4(col, 0.95);
}
`;

const OP_RING_VERTEX = /* glsl */ `
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const OP_RING_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uAccentColor;
in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  float w1 = fract(uTime * 0.55);
  float w2 = fract(uTime * 0.55 + 0.5);
  float ring1 = (1.0 - smoothstep(0.0, 0.065, abs(r - w1))) * (1.0 - w1);
  float ring2 = (1.0 - smoothstep(0.0, 0.065, abs(r - w2))) * (1.0 - w2);
  float outerRim = (1.0 - smoothstep(0.0, 0.055, abs(r - 0.86))) * 0.55;
  float centerGlow = (1.0 - smoothstep(0.0, 0.28, r)) * 0.42;

  vec3 gold = vec3(1.0, 0.84, 0.36);
  vec3 col = mix(uAccentColor, gold, 0.55);
  float alpha = clamp((ring1 + ring2) * 0.78 + outerRim + centerGlow, 0.0, 0.86);
  if (alpha < 0.01) discard;
  fragColor = vec4(col, alpha);
}
`;

interface CourierOrb {
  active: boolean;
  sx: number;
  sy: number;
  sz: number;
  cx: number;
  cy: number;
  cz: number;
  tx: number;
  ty: number;
  tz: number;
  t: number;
  duration: number;
  colorHex: number;
  trailAccum: number;
}

interface TrailBead {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vy: number;
  scale: number;
  life: number;
  maxLife: number;
  colorHex: number;
}

interface SkyRingState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  cooldown: number;
  flashTimer: number;
}

interface JointMissionArchSlot {
  active: boolean;
  sx: number;
  sy: number;
  sz: number;
  cx: number;
  cy: number;
  cz: number;
  tx: number;
  ty: number;
  tz: number;
  age: number;
  duration: number;
  colorHex: number;
  sparkleAccum: number;
}

interface WorkingVillageSlot {
  x: number;
  z: number;
  radius: number;
  accentHex: number;
}

interface FireworkSpark {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  colorHex: number;
  scale: number;
}

interface FireworkShell {
  active: boolean;
  x: number;
  z: number;
  startY: number;
  apexY: number;
  age: number;
  burstSpawned: boolean;
  accentHex: number;
  trailAccum: number;
  readonly sparks: FireworkSpark[];
}

interface ActiveOperationFlag {
  active: boolean;
  id: string;
  x: number;
  z: number;
  hasOrigin: boolean;
  originX: number;
  originZ: number;
  accentHex: number;
}

export function createLivingWorkflowFx(
  scene: Scene,
  getGroundHeight: (x: number, z: number) => number = () => 0,
): LivingWorkflowFx {
  const root = new Group();
  root.name = "the-world-living-workflow-fx";
  scene.add(root);

  // 1. 긴급 황금 오로라 비콘 기둥 (외곽 오로라 + 내부 코어 빔, 2 InstancedMesh 풀)
  const outerPillarGeo = new CylinderGeometry(0.92, 1.38, 22.0, 20, 1, true);
  outerPillarGeo.translate(0, 11.0, 0);
  const innerPillarGeo = new CylinderGeometry(0.32, 0.56, 22.0, 14, 1, true);
  innerPillarGeo.translate(0, 11.0, 0);

  const outerPillarMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uCoreBoost: { value: 0.0 },
    },
    vertexShader: AURORA_PILLAR_VERTEX,
    fragmentShader: AURORA_PILLAR_FRAGMENT,
  });

  const innerPillarMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uCoreBoost: { value: 1.0 },
    },
    vertexShader: AURORA_PILLAR_VERTEX,
    fragmentShader: AURORA_PILLAR_FRAGMENT,
  });

  const outerPillarInst = new InstancedMesh(outerPillarGeo, outerPillarMat, MAX_PILLARS);
  outerPillarInst.instanceMatrix.setUsage(DynamicDrawUsage);
  outerPillarInst.frustumCulled = false;
  outerPillarInst.count = 0;
  outerPillarInst.visible = false;
  outerPillarInst.renderOrder = 6;
  root.add(outerPillarInst);

  const innerPillarInst = new InstancedMesh(innerPillarGeo, innerPillarMat, MAX_PILLARS);
  innerPillarInst.instanceMatrix.setUsage(DynamicDrawUsage);
  innerPillarInst.frustumCulled = false;
  innerPillarInst.count = 0;
  innerPillarInst.visible = false;
  innerPillarInst.renderOrder = 7;
  root.add(innerPillarInst);

  // 2. 별빛 전령 구슬 (본체 + 별꼬리 비즈, 2 InstancedMesh 풀)
  const orbGeo = new SphereGeometry(0.22, 10, 8);
  const orbMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.94,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const orbInst = new InstancedMesh(orbGeo, orbMat, MAX_COURIERS);
  orbInst.instanceMatrix.setUsage(DynamicDrawUsage);
  orbInst.frustumCulled = false;
  orbInst.count = 0;
  orbInst.visible = false;
  orbInst.renderOrder = 9;
  root.add(orbInst);

  const trailGeo = new SphereGeometry(0.11, 6, 5);
  const trailMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.78,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const trailInst = new InstancedMesh(trailGeo, trailMat, MAX_TRAIL_BEADS);
  trailInst.instanceMatrix.setUsage(DynamicDrawUsage);
  trailInst.frustumCulled = false;
  trailInst.count = 0;
  trailInst.visible = false;
  trailInst.renderOrder = 8;
  root.add(trailInst);

  // 3. 마을 목표 진행 별빛 크리스탈 (외곽 유리 셸 + 내부 진행도 발광 코어, 2 InstancedMesh 풀)
  const crystalOuterGeo = new OctahedronGeometry(0.62, 0);
  const crystalOuterMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.34,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const crystalOuterInst = new InstancedMesh(crystalOuterGeo, crystalOuterMat, MAX_CRYSTALS);
  crystalOuterInst.instanceMatrix.setUsage(DynamicDrawUsage);
  crystalOuterInst.frustumCulled = false;
  crystalOuterInst.count = 0;
  crystalOuterInst.visible = false;
  crystalOuterInst.renderOrder = 7;
  root.add(crystalOuterInst);

  const crystalCoreGeo = new OctahedronGeometry(0.36, 0);
  const crystalCoreMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const crystalCoreInst = new InstancedMesh(crystalCoreGeo, crystalCoreMat, MAX_CRYSTALS);
  crystalCoreInst.instanceMatrix.setUsage(DynamicDrawUsage);
  crystalCoreInst.frustumCulled = false;
  crystalCoreInst.count = 0;
  crystalCoreInst.visible = false;
  crystalCoreInst.renderOrder = 8;
  root.add(crystalCoreInst);

  // 4. 하늘 순찰 황금 별빛 링 8기 (GLSL3 회전 쉐브론/글로우 셰이더 외곽 링 + 코어 링, 비행 중에만 활성화)
  const skyRingOuterGeo = new TorusGeometry(2.85, 0.19, 12, 36);
  const skyRingOuterMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uCorePass: { value: 0 },
    },
    vertexShader: SKY_RING_VERTEX,
    fragmentShader: SKY_RING_FRAGMENT,
  });
  const skyRingOuterInst = new InstancedMesh(skyRingOuterGeo, skyRingOuterMat, SKY_RING_COUNT);
  skyRingOuterInst.instanceMatrix.setUsage(DynamicDrawUsage);
  skyRingOuterInst.frustumCulled = false;
  skyRingOuterInst.count = SKY_RING_COUNT;
  skyRingOuterInst.visible = false;
  skyRingOuterInst.renderOrder = 9;
  root.add(skyRingOuterInst);

  const skyRingCoreGeo = new TorusGeometry(2.38, 0.075, 8, 32);
  const skyRingCoreMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uCorePass: { value: 1 },
    },
    vertexShader: SKY_RING_VERTEX,
    fragmentShader: SKY_RING_FRAGMENT,
  });
  const skyRingCoreInst = new InstancedMesh(skyRingCoreGeo, skyRingCoreMat, SKY_RING_COUNT);
  skyRingCoreInst.instanceMatrix.setUsage(DynamicDrawUsage);
  skyRingCoreInst.frustumCulled = false;
  skyRingCoreInst.count = SKY_RING_COUNT;
  skyRingCoreInst.visible = false;
  skyRingCoreInst.renderOrder = 10;
  root.add(skyRingCoreInst);

  // 4b. 하늘 순찰 링 안쪽을 공전하는 작은 황금 별빛 룬 파티클 (링당 4개 × 8기 = 32, 1 Draw Call)
  const skyRingRuneGeo = new OctahedronGeometry(0.15, 0);
  const skyRingRuneMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.86,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const skyRingRuneInst = new InstancedMesh(skyRingRuneGeo, skyRingRuneMat, SKY_RING_TOTAL_RUNES);
  skyRingRuneInst.instanceMatrix.setUsage(DynamicDrawUsage);
  skyRingRuneInst.frustumCulled = false;
  skyRingRuneInst.count = SKY_RING_TOTAL_RUNES;
  skyRingRuneInst.visible = false;
  skyRingRuneInst.renderOrder = 10;
  root.add(skyRingRuneInst);

  // 5. 합동 작전 별빛 아치 광선 (2차 베지어 세그먼트 1 InstancedMesh 풀, 0 할당)
  const archSegGeo = new CylinderGeometry(0.16, 0.16, 1.0, 8, 1, true);
  const archSegMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.84,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const archSegInst = new InstancedMesh(archSegGeo, archSegMat, MAX_ARCH_INSTANCES);
  archSegInst.instanceMatrix.setUsage(DynamicDrawUsage);
  archSegInst.frustumCulled = false;
  archSegInst.count = 0;
  archSegInst.visible = false;
  archSegInst.renderOrder = 9;
  root.add(archSegInst);

  // 6. 마을 정문 결재/검토 황금 우편함 봉투·왕관 크레스트 비콘 (2 InstancedMesh 풀)
  const mailboxBodyGeo = new BoxGeometry(0.86, 0.56, 0.14);
  const mailboxBodyMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.90,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const mailboxBodyInst = new InstancedMesh(mailboxBodyGeo, mailboxBodyMat, MAX_MAILBOX_CRESTS);
  mailboxBodyInst.instanceMatrix.setUsage(DynamicDrawUsage);
  mailboxBodyInst.frustumCulled = false;
  mailboxBodyInst.count = 0;
  mailboxBodyInst.visible = false;
  mailboxBodyInst.renderOrder = 8;
  root.add(mailboxBodyInst);

  const mailboxSealGeo = new OctahedronGeometry(0.24, 0);
  const mailboxSealMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const mailboxSealInst = new InstancedMesh(mailboxSealGeo, mailboxSealMat, MAX_MAILBOX_CRESTS);
  mailboxSealInst.instanceMatrix.setUsage(DynamicDrawUsage);
  mailboxSealInst.frustumCulled = false;
  mailboxSealInst.count = 0;
  mailboxSealInst.visible = false;
  mailboxSealInst.renderOrder = 9;
  root.add(mailboxSealInst);

  // 7. 실시간 작업 공방 별빛 설계도 홀로그램 링 + 황금 공방 불꽃 (2 InstancedMesh 풀, 0-GC)
  const workHoloRingGeo = new TorusGeometry(1.75, 0.055, 8, 36);
  const workHoloRingMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: WORK_HOLO_VERTEX,
    fragmentShader: WORK_HOLO_FRAGMENT,
  });
  const workHoloRingInst = new InstancedMesh(workHoloRingGeo, workHoloRingMat, MAX_WORKING_VILLAGES);
  workHoloRingInst.instanceMatrix.setUsage(DynamicDrawUsage);
  workHoloRingInst.frustumCulled = false;
  workHoloRingInst.count = 0;
  workHoloRingInst.visible = false;
  workHoloRingInst.renderOrder = 8;
  root.add(workHoloRingInst);

  const workSparkGeo = new OctahedronGeometry(0.11, 0);
  const workSparkMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.84,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const workSparkInst = new InstancedMesh(workSparkGeo, workSparkMat, MAX_WORK_SPARKS);
  workSparkInst.instanceMatrix.setUsage(DynamicDrawUsage);
  workSparkInst.frustumCulled = false;
  workSparkInst.count = 0;
  workSparkInst.visible = false;
  workSparkInst.renderOrder = 9;
  root.add(workSparkInst);

  // 8. 목표 완료 지브리풍 3D 불꽃놀이 (최대 3발 동시 풀링: 상승 유성 + 34발 파스텔/황금 꽃불, 0-GC)
  const fwRocketGeo = new SphereGeometry(0.20, 8, 6);
  const fwRocketMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const fwRocketInst = new InstancedMesh(fwRocketGeo, fwRocketMat, MAX_FIREWORKS);
  fwRocketInst.instanceMatrix.setUsage(DynamicDrawUsage);
  fwRocketInst.frustumCulled = false;
  fwRocketInst.count = 0;
  fwRocketInst.visible = false;
  fwRocketInst.renderOrder = 10;
  root.add(fwRocketInst);

  const fwSparkGeo = new OctahedronGeometry(0.16, 0);
  const fwSparkMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const fwSparkInst = new InstancedMesh(fwSparkGeo, fwSparkMat, MAX_FW_SPARKS);
  fwSparkInst.instanceMatrix.setUsage(DynamicDrawUsage);
  fwSparkInst.frustumCulled = false;
  fwSparkInst.count = 0;
  fwSparkInst.visible = false;
  fwSparkInst.renderOrder = 10;
  root.add(fwSparkInst);

  // 9. 3D 작전 깃발(웨이포인트) + 바닥 파동 링 + 출동 별빛 궤적 (0-GC)
  const opFlagGroup = new Group();
  opFlagGroup.visible = false;
  const opPoleGeo = new CylinderGeometry(0.055, 0.072, 3.6, 10);
  const opPoleMat = new MeshStandardMaterial({
    color: 0xeab308,
    emissive: 0xb45309,
    emissiveIntensity: 0.28,
    roughness: 0.30,
    metalness: 0.72,
  });
  const opPoleMesh = new Mesh(opPoleGeo, opPoleMat);
  opPoleMesh.position.y = 1.8;
  const opFinialGeo = new OctahedronGeometry(0.24, 0);
  const opFinialMat = new MeshBasicMaterial({
    color: 0xfde047,
    transparent: true,
    opacity: 0.94,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const opFinialMesh = new Mesh(opFinialGeo, opFinialMat);
  opFinialMesh.position.y = 3.74;
  const opBannerGeo = new PlaneGeometry(1.42, 0.72, 10, 2);
  opBannerGeo.translate(0.71, 0, 0);
  const opBannerMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uAccentColor: { value: new Color(0xfbbf24) },
    },
    vertexShader: OP_FLAG_VERTEX,
    fragmentShader: OP_FLAG_FRAGMENT,
  });
  const opBannerMesh = new Mesh(opBannerGeo, opBannerMat);
  opBannerMesh.position.set(0.04, 3.12, 0);
  opFlagGroup.add(opPoleMesh, opFinialMesh, opBannerMesh);
  root.add(opFlagGroup);

  const opRingGeo = new PlaneGeometry(4.4, 4.4);
  opRingGeo.rotateX(-Math.PI * 0.5);
  const opRingMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uAccentColor: { value: new Color(0xfbbf24) },
    },
    vertexShader: OP_RING_VERTEX,
    fragmentShader: OP_RING_FRAGMENT,
  });
  const opFlagRingMesh = new Mesh(opRingGeo, opRingMat);
  opFlagRingMesh.visible = false;
  opFlagRingMesh.renderOrder = 6;
  root.add(opFlagRingMesh);

  const opTrajGeo = new SphereGeometry(0.14, 8, 6);
  const opTrajMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.88,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const opTrajInst = new InstancedMesh(opTrajGeo, opTrajMat, OP_TRAJ_COUNT);
  opTrajInst.instanceMatrix.setUsage(DynamicDrawUsage);
  opTrajInst.frustumCulled = false;
  opTrajInst.count = 0;
  opTrajInst.visible = false;
  opTrajInst.renderOrder = 9;
  root.add(opTrajInst);

  const skyRings: SkyRingState[] = Array.from({ length: SKY_RING_COUNT }, (_, idx) => {
    const angle = (idx / SKY_RING_COUNT) * Math.PI * 2;
    const rx = 50.0;
    const rz = 44.0;
    const x = Math.cos(angle) * rx;
    const z = Math.sin(angle) * rz;
    const y = 18.2 + Math.sin(idx * 1.35) * 0.95;
    const tangentX = -Math.sin(angle) * rx;
    const tangentZ = Math.cos(angle) * rz;
    return {
      x,
      y,
      z,
      yaw: Math.atan2(tangentX, tangentZ),
      cooldown: 0,
      flashTimer: 0,
    };
  });
  let skyRingsVisible = false;
  let skyRingCombo = 0;
  let skyRingComboTimer = 0;

  const jointArches: JointMissionArchSlot[] = Array.from({ length: MAX_JOINT_ARCHES }, () => ({
    active: false,
    sx: 0,
    sy: 0,
    sz: 0,
    cx: 0,
    cy: 0,
    cz: 0,
    tx: 0,
    ty: 0,
    tz: 0,
    age: 0,
    duration: JOINT_ARCH_DURATION_SEC,
    colorHex: 0xfde047,
    sparkleAccum: 0,
  }));

  // 제로-GC 풀링 슬롯 & 스크래치 객체
  const couriers: CourierOrb[] = Array.from({ length: MAX_COURIERS }, () => ({
    active: false,
    sx: 0,
    sy: 0,
    sz: 0,
    cx: 0,
    cy: 0,
    cz: 0,
    tx: 0,
    ty: 0,
    tz: 0,
    t: 0,
    duration: 1,
    colorHex: 0xfde047,
    trailAccum: 0,
  }));

  const trails: TrailBead[] = Array.from({ length: MAX_TRAIL_BEADS }, () => ({
    active: false,
    x: 0,
    y: 0,
    z: 0,
    vy: 0,
    scale: 1,
    life: 0,
    maxLife: 0.4,
    colorHex: 0xfde047,
  }));
  let trailWriteCursor = 0;

  // 워크플로우 변화 감지 캐시 (완료 플래시 & 자동 전령 펄스)
  const prevActorSig = new Map<string, string>();
  const prevCompletedByVillage = new Map<string, number>();
  const villageFlashTimer = new Map<string, number>();
  let autoPulseTimer = 1.6;
  let initializedSnapshot = false;

  const tmpMat = new Matrix4();
  const tmpPos = new Vector3();
  const tmpScale = new Vector3();
  const tmpEuler = new Euler();
  const tmpQuat = new Quaternion();
  const tmpDir = new Vector3();
  const tmpUp = new Vector3(0, 1, 0);
  const tmpPrev = new Vector3();
  const tmpNext = new Vector3();
  const tmpColor = new Color();
  const tmpColorA = new Color();
  const tmpColorB = new Color();

  const workingVillages: WorkingVillageSlot[] = Array.from({ length: MAX_WORKING_VILLAGES }, () => ({
    x: 0,
    z: 0,
    radius: 5.5,
    accentHex: 0xfbbf24,
  }));
  let workingVillageCount = 0;

  const fireworks: FireworkShell[] = Array.from({ length: MAX_FIREWORKS }, () => ({
    active: false,
    x: 0,
    z: 0,
    startY: 0,
    apexY: 16,
    age: 0,
    burstSpawned: false,
    accentHex: 0xfbbf24,
    trailAccum: 0,
    sparks: Array.from({ length: FW_SPARKS_PER_SHELL }, () => ({
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      colorHex: 0xfde047,
      scale: 1,
    })),
  }));

  const activeOpFlag: ActiveOperationFlag = {
    active: false,
    id: "",
    x: 0,
    z: 0,
    hasOrigin: false,
    originX: 0,
    originZ: 0,
    accentHex: 0xfbbf24,
  };

  function setSkyRingsVisible(visible: boolean): void {
    if (skyRingsVisible === visible) return;
    skyRingsVisible = visible;
    if (!visible) {
      skyRingCombo = 0;
      skyRingComboTimer = 0;
      skyRingOuterInst.visible = false;
      skyRingCoreInst.visible = false;
      skyRingRuneInst.visible = false;
    }
  }

  function resetSkyRingCombo(): void {
    skyRingCombo = 0;
    skyRingComboTimer = 0;
  }

  function getNearestReadySkyRing(
    px: number,
    py: number,
    pz: number,
    out: SkyRingPositionOut,
  ): boolean {
    if (!skyRingsVisible) return false;
    let bestIdx = -1;
    let bestDistSq = Infinity;
    for (let i = 0; i < SKY_RING_COUNT; i += 1) {
      const ring = skyRings[i]!;
      if (ring.cooldown > 0) continue;
      const dx = ring.x - px;
      const dy = ring.y - py;
      const dz = ring.z - pz;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return false;
    const best = skyRings[bestIdx]!;
    out.x = best.x;
    out.y = best.y;
    out.z = best.z;
    out.distM = Math.sqrt(bestDistSq);
    return true;
  }

  function checkSkyRingPass(
    px: number,
    py: number,
    pz: number,
    isFlying: boolean,
  ): SkyRingPassResult | null {
    if (!skyRingsVisible || !isFlying) return null;
    for (let i = 0; i < SKY_RING_COUNT; i += 1) {
      const ring = skyRings[i]!;
      if (ring.cooldown > 0) continue;
      const dx = px - ring.x;
      const dy = (py - ring.y) * 1.05;
      const dz = pz - ring.z;
      if (dx * dx + dy * dy + dz * dz <= 3.85 * 3.85) {
        ring.cooldown = SKY_RING_COOLDOWN_SEC;
        ring.flashTimer = 0.9;
        skyRingCombo = Math.min(8, skyRingCombo + 1);
        skyRingComboTimer = SKY_RING_COMBO_WINDOW_SEC;
        // 링 둘레로 황금 별빛 버스트 방출
        const rightX = Math.cos(ring.yaw);
        const rightZ = -Math.sin(ring.yaw);
        for (let b = 0; b < 12; b += 1) {
          const ang = (b / 12) * Math.PI * 2;
          const rCos = Math.cos(ang) * 2.75;
          const rSin = Math.sin(ang) * 2.75;
          pushTrailBead(
            ring.x + rightX * rCos,
            ring.y + rSin,
            ring.z + rightZ * rCos,
            b % 2 === 0 ? 0xfbbf24 : 0xfef3c7,
            1.35,
          );
        }
        return {
          ringIndex: i,
          combo: skyRingCombo,
          comboCount: skyRingCombo,
          boostTrigger: true,
        };
      }
    }
    return null;
  }

  function syncWorkingVillages(villages: readonly WorkingVillageFxInput[]): void {
    const count = Math.min(MAX_WORKING_VILLAGES, villages.length);
    workingVillageCount = count;
    for (let i = 0; i < count; i += 1) {
      const src = villages[i]!;
      const dst = workingVillages[i]!;
      dst.x = src.x;
      dst.z = src.z;
      dst.radius = src.radius;
      dst.accentHex = src.accentHex;
    }
    if (count === 0) {
      workHoloRingInst.visible = false;
      workSparkInst.visible = false;
    }
  }

  const FW_PALETTE = [0xfde047, 0xf9a8d4, 0x7dd3fc, 0xfffbeb, 0xfdba74] as const;

  function triggerVillageFirework(x: number, z: number, accentHex = 0xfbbf24): void {
    let slot: FireworkShell | null = null;
    for (let i = 0; i < MAX_FIREWORKS; i += 1) {
      if (!fireworks[i]!.active) {
        slot = fireworks[i]!;
        break;
      }
    }
    if (!slot) {
      let oldest = fireworks[0]!;
      for (let i = 1; i < MAX_FIREWORKS; i += 1) {
        if (fireworks[i]!.age > oldest.age) oldest = fireworks[i]!;
      }
      slot = oldest;
    }

    const gy = getGroundHeight(x, z);
    slot.active = true;
    slot.x = x;
    slot.z = z;
    slot.startY = gy + 1.6;
    slot.apexY = gy + 16.0;
    slot.age = 0;
    slot.burstSpawned = false;
    slot.accentHex = accentHex;
    slot.trailAccum = 0;

    // 34개 파스텔·황금 별빛 꽃불 방향을 황금각 피보나치 구면으로 사전 초기화 (0-GC)
    const goldenAngle = 2.39996323;
    for (let s = 0; s < FW_SPARKS_PER_SHELL; s += 1) {
      const sp = slot.sparks[s]!;
      const u = 1 - ((s + 0.5) / FW_SPARKS_PER_SHELL) * 2;
      const rPlane = Math.sqrt(Math.max(0, 1 - u * u));
      const theta = goldenAngle * s + (Math.random() - 0.5) * 0.22;
      const speed = 4.6 + (s % 5) * 0.58 + Math.random() * 0.9;
      sp.x = x;
      sp.y = slot.apexY;
      sp.z = z;
      sp.vx = Math.cos(theta) * rPlane * speed;
      sp.vy = u * speed + 1.15;
      sp.vz = Math.sin(theta) * rPlane * speed;
      sp.colorHex = s % 3 === 0 ? accentHex : FW_PALETTE[s % FW_PALETTE.length]!;
      sp.scale = 0.85 + (s % 4) * 0.16;
    }
  }

  function setOperationFlag(flag: OperationFlagFxInput | null): void {
    if (!flag) {
      activeOpFlag.active = false;
      opFlagGroup.visible = false;
      opFlagRingMesh.visible = false;
      opTrajInst.visible = false;
      return;
    }
    activeOpFlag.active = true;
    activeOpFlag.id = flag.id;
    activeOpFlag.x = flag.x;
    activeOpFlag.z = flag.z;
    activeOpFlag.hasOrigin = flag.originX !== undefined && flag.originZ !== undefined;
    activeOpFlag.originX = flag.originX ?? flag.x;
    activeOpFlag.originZ = flag.originZ ?? flag.z;
    activeOpFlag.accentHex = flag.accentHex ?? 0xfbbf24;
    (opBannerMat.uniforms["uAccentColor"]!.value as Color).setHex(activeOpFlag.accentHex);
    (opRingMat.uniforms["uAccentColor"]!.value as Color).setHex(activeOpFlag.accentHex);
  }

  function spawnJointMissionArch(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    colorHex = 0xfde047,
  ): void {
    const dist = Math.hypot(toX - fromX, toZ - fromZ);
    if (dist < 1.2) return;

    let slot: JointMissionArchSlot | null = null;
    for (let i = 0; i < MAX_JOINT_ARCHES; i += 1) {
      if (!jointArches[i]!.active) {
        slot = jointArches[i]!;
        break;
      }
    }
    if (!slot) {
      let oldest = jointArches[0]!;
      for (let i = 1; i < MAX_JOINT_ARCHES; i += 1) {
        if (jointArches[i]!.age > oldest.age) oldest = jointArches[i]!;
      }
      slot = oldest;
    }

    const sy = getGroundHeight(fromX, fromZ) + 2.4;
    const ty = getGroundHeight(toX, toZ) + 2.4;
    const apexLift = Math.max(10.0, Math.min(24.0, dist * 0.32));

    slot.active = true;
    slot.sx = fromX;
    slot.sy = sy;
    slot.sz = fromZ;
    slot.tx = toX;
    slot.ty = ty;
    slot.tz = toZ;
    slot.cx = (fromX + toX) * 0.5;
    slot.cy = Math.max(sy, ty) + apexLift;
    slot.cz = (fromZ + toZ) * 0.5;
    slot.age = 0;
    slot.duration = JOINT_ARCH_DURATION_SEC;
    slot.colorHex = colorHex;
    slot.sparkleAccum = 0;

    for (let k = 0; k < 5; k += 1) {
      pushTrailBead(fromX, sy + k * 0.22, fromZ, colorHex, 1.25);
    }
  }

  function pushTrailBead(x: number, y: number, z: number, colorHex: number, scale = 0.85): void {
    const slot = trails[trailWriteCursor]!;
    trailWriteCursor = (trailWriteCursor + 1) % MAX_TRAIL_BEADS;
    slot.active = true;
    slot.x = x + (Math.random() - 0.5) * 0.08;
    slot.y = y + (Math.random() - 0.5) * 0.08;
    slot.z = z + (Math.random() - 0.5) * 0.08;
    slot.vy = 0.22 + Math.random() * 0.25;
    slot.scale = scale;
    slot.life = 0.42;
    slot.maxLife = 0.42;
    slot.colorHex = colorHex;
  }

  function spawnCourier(from: LivingWorkflowPoint, to: LivingWorkflowPoint, colorHex = 0xfde047): void {
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    if (dist < 0.6) return;

    let slot: CourierOrb | null = null;
    for (let i = 0; i < MAX_COURIERS; i += 1) {
      if (!couriers[i]!.active) {
        slot = couriers[i]!;
        break;
      }
    }
    if (!slot) {
      // 풀이 가득 차면 가장 오래 진행한 슬롯을 재사용한다.
      let best = couriers[0]!;
      for (let i = 1; i < MAX_COURIERS; i += 1) {
        if (couriers[i]!.t > best.t) best = couriers[i]!;
      }
      slot = best;
    }

    const sy = from.y ?? (getGroundHeight(from.x, from.z) + 1.45);
    const ty = to.y ?? (getGroundHeight(to.x, to.z) + 1.45);
    const arcLift = Math.max(2.6, Math.min(8.5, dist * 0.26));

    slot.active = true;
    slot.sx = from.x;
    slot.sy = sy;
    slot.sz = from.z;
    slot.tx = to.x;
    slot.ty = ty;
    slot.tz = to.z;
    slot.cx = (from.x + to.x) * 0.5;
    slot.cy = Math.max(sy, ty) + arcLift;
    slot.cz = (from.z + to.z) * 0.5;
    slot.t = 0;
    slot.duration = Math.max(0.75, Math.min(1.55, 0.65 + dist * 0.03));
    slot.colorHex = colorHex;
    slot.trailAccum = 0;
  }

  function resolveActorHex(actor: WorldActorSpec): number {
    const rgb = PLUSH_VIVID_TONES[actor.tone];
    tmpColor.setRGB(rgb[0], rgb[1], rgb[2]);
    return tmpColor.getHex();
  }

  function findPeerForCourier(
    actor: WorldActorSpec,
    actors: readonly WorldActorSpec[],
    villages: readonly WorldVillageSpec[],
  ): LivingWorkflowPoint | null {
    if (actor.role === "member") {
      const cmdr = actors.find((a) => a.role === "commander" && a.zoneId === actor.zoneId);
      if (cmdr) return { x: cmdr.homeX, z: cmdr.homeZ };
    }
    if (actor.role === "commander") {
      const comm = actors.find((a) => a.role === "commodore" && a.commodoreId && a.commodoreId === actor.commodoreId);
      if (comm) return { x: comm.homeX, z: comm.homeZ };
      const sub = actors.find((a) => a.role === "member" && a.zoneId === actor.zoneId);
      if (sub) return { x: sub.homeX, z: sub.homeZ };
    }
    if (actor.role === "commodore" && actor.commodoreId) {
      const cmdr = actors.find((a) => a.role === "commander" && a.commodoreId === actor.commodoreId);
      if (cmdr) return { x: cmdr.homeX, z: cmdr.homeZ };
      const village = villages.find((v) => v.commodoreId === actor.commodoreId);
      if (village && village.districts.length > 0) {
        const activeD = village.districts.find((d) => d.activeWorkStep !== null) ?? village.districts[0]!;
        return { x: activeD.x, z: activeD.z };
      }
    }
    return null;
  }

  function update(
    dt: number,
    elapsed: number,
    villages: readonly WorldVillageSpec[],
    actors: readonly WorldActorSpec[],
  ): void {
    const safeDt = Math.min(0.05, Math.max(0, dt));

    // 1) 긴급 별빛 비콘 기둥 갱신
    outerPillarMat.uniforms["uTime"]!.value = elapsed;
    innerPillarMat.uniforms["uTime"]!.value = elapsed;

    let pillarCount = 0;
    const coveredCommodores = new Set<string>();
    for (let i = 0; i < villages.length && pillarCount < MAX_PILLARS; i += 1) {
      const v = villages[i]!;
      if (!v.needsAttention && v.openAsksCount <= 0) continue;
      coveredCommodores.add(v.commodoreId);
      const gy = getGroundHeight(v.x, v.z);
      const breath = 1.0 + Math.sin(elapsed * 2.6 + i) * 0.08;
      tmpPos.set(v.x, gy + 0.05, v.z);
      tmpQuat.identity();
      tmpScale.set(breath, 1.0, breath);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      outerPillarInst.setMatrixAt(pillarCount, tmpMat);
      innerPillarInst.setMatrixAt(pillarCount, tmpMat);
      pillarCount += 1;
    }

    // 마을이 아직 없거나 비어 있는 긴급 사령관도 직접 커버
    for (let i = 0; i < actors.length && pillarCount < MAX_PILLARS; i += 1) {
      const a = actors[i]!;
      if (!a.needsAttention) continue;
      if (a.commodoreId && coveredCommodores.has(a.commodoreId)) continue;
      if (a.commodoreId) coveredCommodores.add(a.commodoreId);
      const gy = getGroundHeight(a.homeX, a.homeZ);
      const breath = 1.0 + Math.sin(elapsed * 2.6 + i) * 0.08;
      tmpPos.set(a.homeX, gy + 0.05, a.homeZ);
      tmpQuat.identity();
      tmpScale.set(breath * 0.88, 1.0, breath * 0.88);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      outerPillarInst.setMatrixAt(pillarCount, tmpMat);
      innerPillarInst.setMatrixAt(pillarCount, tmpMat);
      pillarCount += 1;
    }

    outerPillarInst.count = pillarCount;
    outerPillarInst.visible = pillarCount > 0;
    innerPillarInst.count = pillarCount;
    innerPillarInst.visible = pillarCount > 0;
    if (pillarCount > 0) {
      outerPillarInst.instanceMatrix.needsUpdate = true;
      innerPillarInst.instanceMatrix.needsUpdate = true;
    }

    // 2) 실시간 활동 변화 감지 → 자동 별빛 전령 구슬 발사 + 완료 플래시
    for (let i = 0; i < actors.length; i += 1) {
      const a = actors[i]!;
      const sig = `${a.state}:${a.activity ?? ""}:${a.needsAttention ? "1" : "0"}`;
      const prev = prevActorSig.get(a.id);
      if (initializedSnapshot && prev !== undefined && prev !== sig && (a.state === "running" || a.needsAttention)) {
        const peer = findPeerForCourier(a, actors, villages);
        if (peer) {
          const hex = a.needsAttention ? 0xfde047 : (a.role === "commodore" ? 0xfbbf24 : 0x38bdf8);
          spawnCourier({ x: a.homeX, z: a.homeZ }, peer, hex);
        }
      }
      prevActorSig.set(a.id, sig);
    }

    // 작업 중인 팀이 살아 움직이도록 주기적 전령 펄스
    autoPulseTimer -= safeDt;
    if (autoPulseTimer <= 0) {
      autoPulseTimer = 2.8 + Math.random() * 1.8;
      const workingActors = actors.filter((a) => a.state === "running" || a.activity !== null);
      if (workingActors.length > 0) {
        const picked = workingActors[Math.floor(Math.random() * workingActors.length)]!;
        const peer = findPeerForCourier(picked, actors, villages);
        if (peer) {
          const colorHex = Math.random() < 0.55 ? 0x38bdf8 : resolveActorHex(picked);
          spawnCourier({ x: picked.homeX, z: picked.homeZ }, peer, colorHex);
        }
      }
    }

    // 전령 구슬 포물선 이동 & 미니 별꼬리 갱신
    let orbCount = 0;
    for (let i = 0; i < MAX_COURIERS; i += 1) {
      const c = couriers[i]!;
      if (!c.active) continue;
      c.t += safeDt / c.duration;
      if (c.t >= 1.0) {
        c.active = false;
        // 도착 지점에 작은 별빛 반짝임 3개
        for (let b = 0; b < 3; b += 1) {
          pushTrailBead(c.tx, c.ty, c.tz, c.colorHex, 1.15);
        }
        continue;
      }

      const u = c.t;
      const inv = 1 - u;
      const x = inv * inv * c.sx + 2 * inv * u * c.cx + u * u * c.tx;
      const y = inv * inv * c.sy + 2 * inv * u * c.cy + u * u * c.ty;
      const z = inv * inv * c.sz + 2 * inv * u * c.cz + u * u * c.tz;

      c.trailAccum += safeDt;
      if (c.trailAccum >= 0.032) {
        c.trailAccum = 0;
        pushTrailBead(x, y, z, c.colorHex, 0.78);
      }

      const pulse = 0.85 + Math.sin(elapsed * 16.0 + i) * 0.18;
      tmpPos.set(x, y, z);
      tmpQuat.identity();
      tmpScale.setScalar(pulse);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      orbInst.setMatrixAt(orbCount, tmpMat);
      tmpColor.setHex(c.colorHex).multiplyScalar(1.35);
      orbInst.setColorAt(orbCount, tmpColor);
      orbCount += 1;
    }

    orbInst.count = orbCount;
    orbInst.visible = orbCount > 0;
    if (orbCount > 0) {
      orbInst.instanceMatrix.needsUpdate = true;
      if (orbInst.instanceColor) orbInst.instanceColor.needsUpdate = true;
    }

    // 미니 별꼬리 비즈 갱신
    let trailCount = 0;
    for (let i = 0; i < MAX_TRAIL_BEADS; i += 1) {
      const tb = trails[i]!;
      if (!tb.active) continue;
      tb.life -= safeDt;
      if (tb.life <= 0) {
        tb.active = false;
        continue;
      }
      tb.y += tb.vy * safeDt;
      const ratio = tb.life / tb.maxLife;
      tmpPos.set(tb.x, tb.y, tb.z);
      tmpQuat.identity();
      tmpScale.setScalar(tb.scale * ratio);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      trailInst.setMatrixAt(trailCount, tmpMat);
      tmpColor.setHex(tb.colorHex).multiplyScalar(0.9 + ratio * 0.55);
      trailInst.setColorAt(trailCount, tmpColor);
      trailCount += 1;
    }

    trailInst.count = trailCount;
    trailInst.visible = trailCount > 0;
    if (trailCount > 0) {
      trailInst.instanceMatrix.needsUpdate = true;
      if (trailInst.instanceColor) trailInst.instanceColor.needsUpdate = true;
    }

    // 3) 마을 목표 진행 별빛 크리스탈 갱신 (진행률 0..1 반영 + 완료 시 황금 플래시)
    let crystalCount = 0;
    for (let i = 0; i < villages.length && crystalCount < MAX_CRYSTALS; i += 1) {
      const v = villages[i]!;
      const prevDone = prevCompletedByVillage.get(v.commodoreId);
      if (initializedSnapshot && prevDone !== undefined && v.completedObjectiveCount > prevDone) {
        villageFlashTimer.set(v.commodoreId, 1.5);
        // 완료 순간 광장으로 황금빛 별구슬 축하 궤적
        spawnCourier(
          { x: v.x, z: v.z, y: getGroundHeight(v.x, v.z) + 5.6 },
          { x: 0, z: -2.0, y: 4.0 },
          0xfde047,
        );
      }
      prevCompletedByVillage.set(v.commodoreId, v.completedObjectiveCount);

      let flash = villageFlashTimer.get(v.commodoreId) ?? 0;
      if (flash > 0) {
        flash = Math.max(0, flash - safeDt);
        if (flash === 0) villageFlashTimer.delete(v.commodoreId);
        else villageFlashTimer.set(v.commodoreId, flash);
      }

      const totalObj = v.activeObjectiveCount + v.completedObjectiveCount;
      if (totalObj <= 0 && flash <= 0) continue;

      // 소속 지휘관의 세부 미션 진행률이 있으면 가중 평균, 없으면 완료/전체 비율 사용
      let missionDone = 0;
      let missionTotal = 0;
      for (let ai = 0; ai < actors.length; ai += 1) {
        const a = actors[ai]!;
        if (a.commodoreId !== v.commodoreId || !a.missions || a.missions.length === 0) continue;
        for (let mi = 0; mi < a.missions.length; mi += 1) {
          missionTotal += 1;
          if (a.missions[mi]!.done) missionDone += 1;
        }
      }
      const progress01 = missionTotal > 0
        ? missionDone / missionTotal
        : (totalObj > 0 ? v.completedObjectiveCount / totalObj : 1.0);
      const flashRatio = flash / 1.5;

      const gy = getGroundHeight(v.x, v.z);
      const bobY = gy + 5.65 + Math.sin(elapsed * 2.1 + i * 1.3) * 0.28;
      const spinY = elapsed * (0.95 + progress01 * 0.85 + flashRatio * 3.0) + i;

      // 외곽 크리스탈 셸
      tmpPos.set(v.x, bobY, v.z);
      tmpEuler.set(0.22 * Math.sin(elapsed * 1.4 + i), spinY, 0.16 * Math.cos(elapsed * 1.1 + i));
      tmpQuat.setFromEuler(tmpEuler);
      const outerScale = 1.0 + flashRatio * 0.55;
      tmpScale.set(outerScale, outerScale * 1.35, outerScale);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      crystalOuterInst.setMatrixAt(crystalCount, tmpMat);

      // 0% 시안 → 50% 에메랄드 → 100% 황금빛 보간
      if (progress01 < 0.5) {
        tmpColorA.setHex(0x38bdf8);
        tmpColorB.setHex(0x34d399);
        tmpColor.copy(tmpColorA).lerp(tmpColorB, progress01 * 2.0);
      } else {
        tmpColorA.setHex(0x34d399);
        tmpColorB.setHex(0xfde047);
        tmpColor.copy(tmpColorA).lerp(tmpColorB, (progress01 - 0.5) * 2.0);
      }
      if (flashRatio > 0) {
        tmpColorB.setHex(0xfef08a);
        tmpColor.lerp(tmpColorB, Math.min(1, flashRatio * 1.2)).multiplyScalar(1.0 + flashRatio * 0.85);
      }
      crystalOuterInst.setColorAt(crystalCount, tmpColor);

      // 내부 진행도 발광 코어 (진행률에 비례해 커지며 밝아짐)
      const coreScale = (0.38 + progress01 * 0.72) * (1.0 + flashRatio * 0.65);
      tmpEuler.set(0, -spinY * 1.4, 0);
      tmpQuat.setFromEuler(tmpEuler);
      tmpScale.set(coreScale, coreScale * 1.38, coreScale);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      crystalCoreInst.setMatrixAt(crystalCount, tmpMat);
      tmpColor.multiplyScalar(1.35);
      crystalCoreInst.setColorAt(crystalCount, tmpColor);

      crystalCount += 1;
    }

    crystalOuterInst.count = crystalCount;
    crystalOuterInst.visible = crystalCount > 0;
    crystalCoreInst.count = crystalCount;
    crystalCoreInst.visible = crystalCount > 0;
    if (crystalCount > 0) {
      crystalOuterInst.instanceMatrix.needsUpdate = true;
      crystalCoreInst.instanceMatrix.needsUpdate = true;
      if (crystalOuterInst.instanceColor) crystalOuterInst.instanceColor.needsUpdate = true;
      if (crystalCoreInst.instanceColor) crystalCoreInst.instanceColor.needsUpdate = true;
    }

    // 4) 하늘 순찰 황금 별빛 링 8기 갱신 (비행 중에만 렌더링)
    if (skyRingComboTimer > 0) {
      skyRingComboTimer = Math.max(0, skyRingComboTimer - safeDt);
      if (skyRingComboTimer === 0) skyRingCombo = 0;
    }
    for (let i = 0; i < SKY_RING_COUNT; i += 1) {
      const ring = skyRings[i]!;
      if (ring.cooldown > 0) ring.cooldown = Math.max(0, ring.cooldown - safeDt);
      if (ring.flashTimer > 0) ring.flashTimer = Math.max(0, ring.flashTimer - safeDt);
    }
    if (skyRingsVisible) {
      skyRingOuterMat.uniforms["uTime"]!.value = elapsed;
      skyRingCoreMat.uniforms["uTime"]!.value = elapsed;
      for (let i = 0; i < SKY_RING_COUNT; i += 1) {
        const ring = skyRings[i]!;
        const bobY = ring.y + Math.sin(elapsed * 2.0 + i * 0.85) * 0.34;
        const flash01 = ring.flashTimer / 0.9;
        const onCooldown = ring.cooldown > 0;
        const outerScale = (onCooldown ? 0.86 : 1.0 + Math.sin(elapsed * 3.0 + i) * 0.04) + flash01 * 0.34;

        tmpPos.set(ring.x, bobY, ring.z);
        tmpEuler.set(0, ring.yaw, elapsed * 0.55 + i * 0.4);
        tmpQuat.setFromEuler(tmpEuler);
        tmpScale.setScalar(outerScale);
        tmpMat.compose(tmpPos, tmpQuat, tmpScale);
        skyRingOuterInst.setMatrixAt(i, tmpMat);

        if (flash01 > 0.01) {
          tmpColor.setHex(0xfde68a).multiplyScalar(0.95 + flash01 * 0.25);
        } else if (onCooldown) {
          tmpColor.setHex(0x38bdf8).multiplyScalar(0.48);
        } else {
          tmpColor.setHex(0xf59e0b).multiplyScalar(0.88);
        }
        skyRingOuterInst.setColorAt(i, tmpColor);

        const coreScale = (onCooldown ? 0.78 : 0.96) + flash01 * 0.34;
        tmpEuler.set(0, ring.yaw, -elapsed * 1.35 - i * 0.6);
        tmpQuat.setFromEuler(tmpEuler);
        tmpScale.setScalar(coreScale);
        tmpMat.compose(tmpPos, tmpQuat, tmpScale);
        skyRingCoreInst.setMatrixAt(i, tmpMat);

        tmpColor.setHex(onCooldown && flash01 <= 0.01 ? 0x7dd3fc : (flash01 > 0.01 ? 0xfef3c7 : 0xfbbf24)).multiplyScalar(onCooldown ? 0.52 : 0.92);
        skyRingCoreInst.setColorAt(i, tmpColor);

        // 링 안쪽을 공전하는 작은 황금 별빛 룬 파티클 4개
        const rightX = Math.cos(ring.yaw);
        const rightZ = -Math.sin(ring.yaw);
        const runeRad = (onCooldown ? 1.82 : 2.08) + flash01 * 0.32;
        for (let r = 0; r < SKY_RING_RUNES_PER_RING; r += 1) {
          const idx = i * SKY_RING_RUNES_PER_RING + r;
          const orbAng = elapsed * 1.45 + r * (Math.PI * 0.5) + i * 0.72;
          const ox = Math.cos(orbAng) * runeRad;
          const oy = Math.sin(orbAng) * runeRad;
          tmpPos.set(ring.x + rightX * ox, bobY + oy, ring.z + rightZ * ox);
          tmpEuler.set(elapsed * 2.2 + r, elapsed * 3.1 + i, orbAng);
          tmpQuat.setFromEuler(tmpEuler);
          const runeScale = (0.78 + 0.28 * Math.sin(elapsed * 5.2 + idx)) * (onCooldown ? 0.65 : 1.0 + flash01 * 0.5);
          tmpScale.setScalar(runeScale);
          tmpMat.compose(tmpPos, tmpQuat, tmpScale);
          skyRingRuneInst.setMatrixAt(idx, tmpMat);
          tmpColor.setHex(onCooldown && flash01 <= 0.01 ? 0x7dd3fc : 0xfbbf24).multiplyScalar(onCooldown ? 0.55 : 0.96);
          skyRingRuneInst.setColorAt(idx, tmpColor);
        }
      }
      skyRingOuterInst.count = SKY_RING_COUNT;
      skyRingOuterInst.visible = true;
      skyRingOuterInst.instanceMatrix.needsUpdate = true;
      if (skyRingOuterInst.instanceColor) skyRingOuterInst.instanceColor.needsUpdate = true;
      skyRingCoreInst.count = SKY_RING_COUNT;
      skyRingCoreInst.visible = true;
      skyRingCoreInst.instanceMatrix.needsUpdate = true;
      if (skyRingCoreInst.instanceColor) skyRingCoreInst.instanceColor.needsUpdate = true;
      skyRingRuneInst.count = SKY_RING_TOTAL_RUNES;
      skyRingRuneInst.visible = true;
      skyRingRuneInst.instanceMatrix.needsUpdate = true;
      if (skyRingRuneInst.instanceColor) skyRingRuneInst.instanceColor.needsUpdate = true;
    } else {
      skyRingOuterInst.visible = false;
      skyRingCoreInst.visible = false;
      skyRingRuneInst.visible = false;
    }

    // 5) 합동 작전 별빛 아치 광선 갱신 (6.5초 fade-in/out + 별빛 트레일)
    let archSegCount = 0;
    for (let ai = 0; ai < MAX_JOINT_ARCHES; ai += 1) {
      const arch = jointArches[ai]!;
      if (!arch.active) continue;
      arch.age += safeDt;
      if (arch.age >= arch.duration) {
        arch.active = false;
        continue;
      }

      const growT = Math.min(1, arch.age / 0.55);
      const fadeOut = arch.age > arch.duration - 1.0
        ? Math.max(0, (arch.duration - arch.age) / 1.0)
        : 1.0;
      const visScale = growT * fadeOut;

      arch.sparkleAccum += safeDt;
      if (arch.sparkleAccum >= 0.14 && fadeOut > 0.25) {
        arch.sparkleAccum = 0;
        const su = (arch.age * 0.58) % 1;
        const sInv = 1 - su;
        const bx = sInv * sInv * arch.sx + 2 * sInv * su * arch.cx + su * su * arch.tx;
        const by = sInv * sInv * arch.sy + 2 * sInv * su * arch.cy + su * su * arch.ty;
        const bz = sInv * sInv * arch.sz + 2 * sInv * su * arch.cz + su * su * arch.tz;
        pushTrailBead(bx, by, bz, arch.colorHex, 1.15);
      }

      const visibleSteps = Math.max(1, Math.floor(ARCH_SEGMENTS * growT));
      for (let s = 0; s < visibleSteps && archSegCount < MAX_ARCH_INSTANCES; s += 1) {
        const u0 = s / ARCH_SEGMENTS;
        const u1 = Math.min(growT, (s + 1) / ARCH_SEGMENTS);
        if (u1 <= u0 + 1e-4) continue;
        const inv0 = 1 - u0;
        const inv1 = 1 - u1;
        tmpPrev.set(
          inv0 * inv0 * arch.sx + 2 * inv0 * u0 * arch.cx + u0 * u0 * arch.tx,
          inv0 * inv0 * arch.sy + 2 * inv0 * u0 * arch.cy + u0 * u0 * arch.ty,
          inv0 * inv0 * arch.sz + 2 * inv0 * u0 * arch.cz + u0 * u0 * arch.tz,
        );
        tmpNext.set(
          inv1 * inv1 * arch.sx + 2 * inv1 * u1 * arch.cx + u1 * u1 * arch.tx,
          inv1 * inv1 * arch.sy + 2 * inv1 * u1 * arch.cy + u1 * u1 * arch.ty,
          inv1 * inv1 * arch.sz + 2 * inv1 * u1 * arch.cz + u1 * u1 * arch.tz,
        );
        tmpDir.subVectors(tmpNext, tmpPrev);
        const segLen = tmpDir.length();
        if (segLen < 1e-4) continue;
        tmpDir.multiplyScalar(1 / segLen);
        tmpPos.addVectors(tmpPrev, tmpNext).multiplyScalar(0.5);
        tmpQuat.setFromUnitVectors(tmpUp, tmpDir);

        const uMid = (u0 + u1) * 0.5;
        const taper = 0.55 + Math.sin(uMid * Math.PI) * 0.75;
        const pulseWave = 0.85 + Math.sin(uMid * 14.0 - elapsed * 7.5) * 0.25;
        const radScale = taper * pulseWave * visScale;
        tmpScale.set(radScale, segLen * 1.06, radScale);
        tmpMat.compose(tmpPos, tmpQuat, tmpScale);
        archSegInst.setMatrixAt(archSegCount, tmpMat);

        tmpColor.setHex(arch.colorHex);
        tmpColorB.setHex(0xfffbeb);
        tmpColor.lerp(tmpColorB, Math.max(0, Math.sin(uMid * 12.0 - elapsed * 6.5) * 0.45)).multiplyScalar(1.25 * fadeOut);
        archSegInst.setColorAt(archSegCount, tmpColor);
        archSegCount += 1;
      }
    }

    archSegInst.count = archSegCount;
    archSegInst.visible = archSegCount > 0;
    if (archSegCount > 0) {
      archSegInst.instanceMatrix.needsUpdate = true;
      if (archSegInst.instanceColor) archSegInst.instanceColor.needsUpdate = true;
    }

    // 6) 마을 결재/검토 대기 황금 우편함 봉투·왕관 크레스트 비콘 갱신
    let mailboxCount = 0;
    for (let i = 0; i < villages.length && mailboxCount < MAX_MAILBOX_CRESTS; i += 1) {
      const v = villages[i]!;
      let hasReviewAlert = v.needsAttention || v.openAsksCount > 0;
      if (!hasReviewAlert) {
        for (let ai = 0; ai < actors.length; ai += 1) {
          const a = actors[ai]!;
          if (a.commodoreId === v.commodoreId && a.needsAttention) {
            hasReviewAlert = true;
            break;
          }
        }
      }
      if (!hasReviewAlert) continue;

      const gateCos = Math.cos(v.gateAngle);
      const gateSin = Math.sin(v.gateAngle);
      const gx = v.x + gateCos * (v.radius + 1.15);
      const gz = v.z + gateSin * (v.radius + 1.15);
      const gy = getGroundHeight(gx, gz) + 4.15 + Math.sin(elapsed * 2.8 + i * 1.1) * 0.28;
      const spin = elapsed * 1.65 + i * 0.7;
      const pulse = 1.0 + Math.sin(elapsed * 4.2 + i) * 0.08;

      tmpPos.set(gx, gy, gz);
      tmpEuler.set(0.12 * Math.sin(elapsed * 2.4 + i), spin, 0.08 * Math.cos(elapsed * 2.1 + i));
      tmpQuat.setFromEuler(tmpEuler);
      tmpScale.setScalar(pulse);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      mailboxBodyInst.setMatrixAt(mailboxCount, tmpMat);
      tmpColor.setHex(0xfde047).multiplyScalar(1.22);
      mailboxBodyInst.setColorAt(mailboxCount, tmpColor);

      tmpPos.set(gx, gy + 0.56, gz);
      tmpEuler.set(0, -spin * 1.6, Math.PI * 0.25);
      tmpQuat.setFromEuler(tmpEuler);
      tmpScale.setScalar(pulse * 1.05);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      mailboxSealInst.setMatrixAt(mailboxCount, tmpMat);
      tmpColor.setHex(0xfffbeb).multiplyScalar(1.42);
      mailboxSealInst.setColorAt(mailboxCount, tmpColor);

      mailboxCount += 1;
    }

    mailboxBodyInst.count = mailboxCount;
    mailboxBodyInst.visible = mailboxCount > 0;
    mailboxSealInst.count = mailboxCount;
    mailboxSealInst.visible = mailboxCount > 0;
    if (mailboxCount > 0) {
      mailboxBodyInst.instanceMatrix.needsUpdate = true;
      mailboxSealInst.instanceMatrix.needsUpdate = true;
      if (mailboxBodyInst.instanceColor) mailboxBodyInst.instanceColor.needsUpdate = true;
      if (mailboxSealInst.instanceColor) mailboxSealInst.instanceColor.needsUpdate = true;
    }

    // 7) 실시간 작업 공방 별빛 설계도 홀로그램 링 + 황금 공방 불꽃 갱신
    if (workingVillageCount > 0) {
      workHoloRingMat.uniforms["uTime"]!.value = elapsed;
      let sparkWrite = 0;
      for (let i = 0; i < workingVillageCount; i += 1) {
        const wv = workingVillages[i]!;
        const gy = getGroundHeight(wv.x, wv.z);
        const bobY = gy + 5.55 + Math.sin(elapsed * 1.7 + i * 1.1) * 0.22;
        const ringScale = Math.min(1.45, Math.max(0.85, wv.radius / 5.4));

        tmpPos.set(wv.x, bobY, wv.z);
        tmpEuler.set(Math.PI * 0.5 + Math.sin(elapsed * 0.9 + i) * 0.14, elapsed * 0.65 + i * 0.8, Math.cos(elapsed * 0.8 + i) * 0.12);
        tmpQuat.setFromEuler(tmpEuler);
        tmpScale.setScalar(ringScale);
        tmpMat.compose(tmpPos, tmpQuat, tmpScale);
        workHoloRingInst.setMatrixAt(i, tmpMat);
        tmpColor.setHex(wv.accentHex).multiplyScalar(0.92);
        workHoloRingInst.setColorAt(i, tmpColor);

        for (let s = 0; s < WORK_SPARKS_PER_VILLAGE && sparkWrite < MAX_WORK_SPARKS; s += 1) {
          const life = ((elapsed * 0.44 + s / WORK_SPARKS_PER_VILLAGE + i * 0.17) % 1 + 1) % 1;
          const orbR = 0.65 + Math.sin(life * Math.PI) * Math.min(1.9, wv.radius * 0.34);
          const orbA = life * Math.PI * 2.6 + s * 1.25 + i * 0.9;
          const sx = wv.x + Math.cos(orbA) * orbR;
          const sz = wv.z + Math.sin(orbA) * orbR;
          const sy = gy + 1.35 + life * 4.85;
          const sc = Math.sin(life * Math.PI) * (0.78 + 0.26 * Math.sin(elapsed * 7.5 + sparkWrite));

          tmpPos.set(sx, sy, sz);
          tmpEuler.set(elapsed * 3.0 + s, elapsed * 2.4 + i, 0);
          tmpQuat.setFromEuler(tmpEuler);
          tmpScale.setScalar(Math.max(0.01, sc));
          tmpMat.compose(tmpPos, tmpQuat, tmpScale);
          workSparkInst.setMatrixAt(sparkWrite, tmpMat);
          tmpColor.setHex(s % 2 === 0 ? 0xfbbf24 : wv.accentHex).multiplyScalar(0.95);
          workSparkInst.setColorAt(sparkWrite, tmpColor);
          sparkWrite += 1;
        }
      }
      workHoloRingInst.count = workingVillageCount;
      workHoloRingInst.visible = true;
      workHoloRingInst.instanceMatrix.needsUpdate = true;
      if (workHoloRingInst.instanceColor) workHoloRingInst.instanceColor.needsUpdate = true;

      workSparkInst.count = sparkWrite;
      workSparkInst.visible = sparkWrite > 0;
      workSparkInst.instanceMatrix.needsUpdate = true;
      if (workSparkInst.instanceColor) workSparkInst.instanceColor.needsUpdate = true;
    } else {
      workHoloRingInst.visible = false;
      workSparkInst.visible = false;
    }

    // 8) 목표 완료 지브리풍 3D 불꽃놀이 갱신 (황금 유성 상승 → 34발 파스텔/황금 꽃불 낙하)
    let fwRocketCount = 0;
    let fwSparkCount = 0;
    const sparkDrag = Math.exp(-safeDt * 1.15);
    for (let fi = 0; fi < MAX_FIREWORKS; fi += 1) {
      const fw = fireworks[fi]!;
      if (!fw.active) continue;
      fw.age += safeDt;

      if (fw.age < FW_ASCENT_SEC) {
        const u = fw.age / FW_ASCENT_SEC;
        const ease = 1 - (1 - u) * (1 - u) * (1 - u);
        const ry = fw.startY + (fw.apexY - fw.startY) * ease;
        const swayX = Math.sin(u * 9.0 + fi) * 0.16 * (1 - u);
        const swayZ = Math.cos(u * 8.0 + fi) * 0.16 * (1 - u);

        tmpPos.set(fw.x + swayX, ry, fw.z + swayZ);
        tmpQuat.identity();
        tmpScale.set(0.85, 1.55, 0.85);
        tmpMat.compose(tmpPos, tmpQuat, tmpScale);
        fwRocketInst.setMatrixAt(fwRocketCount, tmpMat);
        tmpColor.setHex(0xfde047).multiplyScalar(1.05);
        fwRocketInst.setColorAt(fwRocketCount, tmpColor);
        fwRocketCount += 1;

        fw.trailAccum += safeDt;
        if (fw.trailAccum >= 0.055) {
          fw.trailAccum = 0;
          pushTrailBead(fw.x + swayX, ry - 0.18, fw.z + swayZ, 0xfbbf24, 0.95);
        }
      } else {
        const burstAge = fw.age - FW_ASCENT_SEC;
        if (burstAge >= FW_BURST_SEC) {
          fw.active = false;
          continue;
        }
        if (!fw.burstSpawned) {
          fw.burstSpawned = true;
          for (let b = 0; b < 6; b += 1) {
            pushTrailBead(fw.x, fw.apexY, fw.z, b % 2 === 0 ? fw.accentHex : 0xfde047, 1.4);
          }
        }
        const fade = 1 - burstAge / FW_BURST_SEC;
        const fadeCurve = fade * fade;
        for (let s = 0; s < FW_SPARKS_PER_SHELL && fwSparkCount < MAX_FW_SPARKS; s += 1) {
          const sp = fw.sparks[s]!;
          sp.vx *= sparkDrag;
          sp.vz *= sparkDrag;
          sp.vy = sp.vy * sparkDrag - 3.25 * safeDt;
          sp.x += sp.vx * safeDt;
          sp.y += sp.vy * safeDt;
          sp.z += sp.vz * safeDt;

          const twinkle = 0.68 + 0.42 * Math.sin(elapsed * 21.0 + s * 1.9 + fi * 3.1);
          const sc = Math.max(0.01, sp.scale * fade * twinkle);
          tmpPos.set(sp.x, sp.y, sp.z);
          tmpEuler.set(elapsed * 4.5 + s, elapsed * 3.8 + fi, 0);
          tmpQuat.setFromEuler(tmpEuler);
          tmpScale.setScalar(sc);
          tmpMat.compose(tmpPos, tmpQuat, tmpScale);
          fwSparkInst.setMatrixAt(fwSparkCount, tmpMat);
          tmpColor.setHex(sp.colorHex).multiplyScalar(0.55 + fadeCurve * 0.55);
          fwSparkInst.setColorAt(fwSparkCount, tmpColor);
          fwSparkCount += 1;
        }
      }
    }
    fwRocketInst.count = fwRocketCount;
    fwRocketInst.visible = fwRocketCount > 0;
    if (fwRocketCount > 0) {
      fwRocketInst.instanceMatrix.needsUpdate = true;
      if (fwRocketInst.instanceColor) fwRocketInst.instanceColor.needsUpdate = true;
    }
    fwSparkInst.count = fwSparkCount;
    fwSparkInst.visible = fwSparkCount > 0;
    if (fwSparkCount > 0) {
      fwSparkInst.instanceMatrix.needsUpdate = true;
      if (fwSparkInst.instanceColor) fwSparkInst.instanceColor.needsUpdate = true;
    }

    // 9) 3D 작전 깃발(웨이포인트) + 바닥 파동 링 + 출동 별빛 궤적 갱신
    if (activeOpFlag.active) {
      const gy = getGroundHeight(activeOpFlag.x, activeOpFlag.z);
      opBannerMat.uniforms["uTime"]!.value = elapsed;
      opRingMat.uniforms["uTime"]!.value = elapsed;

      opFlagGroup.position.set(activeOpFlag.x, gy, activeOpFlag.z);
      opFlagGroup.visible = true;
      opFinialMesh.rotation.y = elapsed * 2.4;
      opFinialMesh.position.y = 3.74 + Math.sin(elapsed * 3.4) * 0.06;

      opFlagRingMesh.position.set(activeOpFlag.x, gy + 0.09, activeOpFlag.z);
      opFlagRingMesh.visible = true;

      if (activeOpFlag.hasOrigin) {
        const dist = Math.hypot(activeOpFlag.x - activeOpFlag.originX, activeOpFlag.z - activeOpFlag.originZ);
        if (dist >= 1.5) {
          const sy = getGroundHeight(activeOpFlag.originX, activeOpFlag.originZ) + 1.45;
          const ty = gy + 2.35;
          const cx = (activeOpFlag.originX + activeOpFlag.x) * 0.5;
          const cz = (activeOpFlag.originZ + activeOpFlag.z) * 0.5;
          const cy = Math.max(sy, ty) + Math.max(3.2, Math.min(12.5, dist * 0.28));

          tmpQuat.identity();
          for (let ti = 0; ti < OP_TRAJ_COUNT; ti += 1) {
            const u = ((ti / OP_TRAJ_COUNT + elapsed * 0.36) % 1 + 1) % 1;
            const inv = 1 - u;
            const bx = inv * inv * activeOpFlag.originX + 2 * inv * u * cx + u * u * activeOpFlag.x;
            const by = inv * inv * sy + 2 * inv * u * cy + u * u * ty;
            const bz = inv * inv * activeOpFlag.originZ + 2 * inv * u * cz + u * u * activeOpFlag.z;
            const envelope = Math.sin(u * Math.PI);
            const sc = Math.max(0.02, (0.55 + envelope * 0.78) * (0.88 + 0.16 * Math.sin(elapsed * 7.0 + ti)));

            tmpPos.set(bx, by, bz);
            tmpScale.setScalar(sc);
            tmpMat.compose(tmpPos, tmpQuat, tmpScale);
            opTrajInst.setMatrixAt(ti, tmpMat);
            tmpColor.setHex(ti % 2 === 0 ? 0xfbbf24 : activeOpFlag.accentHex).multiplyScalar(0.75 + envelope * 0.35);
            opTrajInst.setColorAt(ti, tmpColor);
          }
          opTrajInst.count = OP_TRAJ_COUNT;
          opTrajInst.visible = true;
          opTrajInst.instanceMatrix.needsUpdate = true;
          if (opTrajInst.instanceColor) opTrajInst.instanceColor.needsUpdate = true;
        } else {
          opTrajInst.visible = false;
        }
      } else {
        opTrajInst.visible = false;
      }
    } else {
      opFlagGroup.visible = false;
      opFlagRingMesh.visible = false;
      opTrajInst.visible = false;
    }

    initializedSnapshot = true;
  }

  function dispose(): void {
    prevActorSig.clear();
    prevCompletedByVillage.clear();
    villageFlashTimer.clear();
    outerPillarInst.dispose();
    innerPillarInst.dispose();
    orbInst.dispose();
    trailInst.dispose();
    crystalOuterInst.dispose();
    crystalCoreInst.dispose();
    skyRingOuterInst.dispose();
    skyRingCoreInst.dispose();
    skyRingRuneInst.dispose();
    archSegInst.dispose();
    mailboxBodyInst.dispose();
    mailboxSealInst.dispose();
    workHoloRingInst.dispose();
    workSparkInst.dispose();
    fwRocketInst.dispose();
    fwSparkInst.dispose();
    opTrajInst.dispose();
    outerPillarGeo.dispose();
    innerPillarGeo.dispose();
    outerPillarMat.dispose();
    innerPillarMat.dispose();
    orbGeo.dispose();
    orbMat.dispose();
    trailGeo.dispose();
    trailMat.dispose();
    crystalOuterGeo.dispose();
    crystalOuterMat.dispose();
    crystalCoreGeo.dispose();
    crystalCoreMat.dispose();
    skyRingOuterGeo.dispose();
    skyRingOuterMat.dispose();
    skyRingCoreGeo.dispose();
    skyRingCoreMat.dispose();
    skyRingRuneGeo.dispose();
    skyRingRuneMat.dispose();
    archSegGeo.dispose();
    archSegMat.dispose();
    mailboxBodyGeo.dispose();
    mailboxBodyMat.dispose();
    mailboxSealGeo.dispose();
    mailboxSealMat.dispose();
    workHoloRingGeo.dispose();
    workHoloRingMat.dispose();
    workSparkGeo.dispose();
    workSparkMat.dispose();
    fwRocketGeo.dispose();
    fwRocketMat.dispose();
    fwSparkGeo.dispose();
    fwSparkMat.dispose();
    opPoleGeo.dispose();
    opPoleMat.dispose();
    opFinialGeo.dispose();
    opFinialMat.dispose();
    opBannerGeo.dispose();
    opBannerMat.dispose();
    opRingGeo.dispose();
    opRingMat.dispose();
    opTrajGeo.dispose();
    opTrajMat.dispose();
    scene.remove(root);
  }

  return {
    spawnCourier,
    setSkyRingsVisible,
    checkSkyRingPass,
    resetSkyRingCombo,
    getNearestReadySkyRing,
    syncWorkingVillages,
    triggerVillageFirework,
    setOperationFlag,
    spawnJointMissionArch,
    update,
    dispose,
  };
}
