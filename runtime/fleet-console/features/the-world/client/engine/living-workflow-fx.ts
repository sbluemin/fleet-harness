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
  MeshBasicMaterial,
  OctahedronGeometry,
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
 */

export interface LivingWorkflowPoint {
  readonly x: number;
  readonly z: number;
  readonly y?: number | undefined;
}

export interface SkyRingPassResult {
  readonly ringIndex: number;
  readonly combo: number;
}

export interface LivingWorkflowFx {
  /** 두 지점 사이로 포물선(2차 베지어) 별빛 전령 구슬을 발사한다. */
  spawnCourier(from: LivingWorkflowPoint, to: LivingWorkflowPoint, colorHex?: number): void;
  /** 하늘 순찰 황금 별빛 링 8기의 가시성을 전환한다 (`overviewMode` 비행 중에만 표시). */
  setSkyRingsVisible(visible: boolean): void;
  /** 비행 중 플레이어 좌표가 8개 별빛 링 중 하나를 통과했는지 판정한다 (6초 쿨다운 + 황금 버스트 + 콤보). */
  checkSkyRingPass(px: number, py: number, pz: number, isFlying: boolean): SkyRingPassResult | null;
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
const SKY_RING_COOLDOWN_SEC = 6.0;
const SKY_RING_COMBO_WINDOW_SEC = 14.0;
const MAX_JOINT_ARCHES = 4;
const ARCH_SEGMENTS = 28;
const MAX_ARCH_INSTANCES = MAX_JOINT_ARCHES * ARCH_SEGMENTS;
const JOINT_ARCH_DURATION_SEC = 6.5;
const MAX_MAILBOX_CRESTS = 16;

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
  // 토러스 둘레를 따라 회전하는 황금 쉐브론 에너지 파동 + 미세 별빛 스파클
  float ang = vUv.x * 6.2831853;
  float tube = abs(vUv.y - 0.5) * 2.0;
  float speed = mix(4.2, -6.8, uCorePass);
  float chevron = 0.5 + 0.5 * sin(ang * 8.0 - uTime * speed + tube * 5.2);
  float chevronSharp = smoothstep(0.28, 0.94, chevron);
  float sparkle = pow(0.5 + 0.5 * sin(ang * 16.0 + uTime * 6.2), 4.0);

  // 시선각 기반 프레넬 글로우로 입체감 있는 빛 고리 연출
  float ndv = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float fresnel = pow(1.0 - clamp(ndv, 0.0, 1.0), 1.65);
  float coreBand = pow(clamp(ndv, 0.0, 1.0), 0.75);

  vec3 warmWhite = vec3(1.0, 0.97, 0.82);
  vec3 col = mix(vInstColor, warmWhite, clamp(chevronSharp * 0.42 + sparkle * 0.35 + uCorePass * 0.25, 0.0, 0.88));
  col *= (0.72 + chevronSharp * 0.55 + fresnel * 0.48 + sparkle * 0.32);

  float alpha = mix(0.46, 0.88, clamp(coreBand * 0.68 + chevronSharp * 0.42 + fresnel * 0.35, 0.0, 1.0));
  alpha *= mix(0.84, 0.92, uCorePass);
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

  function setSkyRingsVisible(visible: boolean): void {
    if (skyRingsVisible === visible) return;
    skyRingsVisible = visible;
    if (!visible) {
      skyRingCombo = 0;
      skyRingComboTimer = 0;
      skyRingOuterInst.visible = false;
      skyRingCoreInst.visible = false;
    }
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
        skyRingCombo += 1;
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
            b % 2 === 0 ? 0xfde047 : 0xfffbeb,
            1.45,
          );
        }
        return { ringIndex: i, combo: skyRingCombo };
      }
    }
    return null;
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
          tmpColor.setHex(0xfffbeb).multiplyScalar(1.35 + flash01 * 0.65);
        } else if (onCooldown) {
          tmpColor.setHex(0x38bdf8).multiplyScalar(0.55);
        } else {
          tmpColor.setHex(0xfde047).multiplyScalar(1.15);
        }
        skyRingOuterInst.setColorAt(i, tmpColor);

        const coreScale = (onCooldown ? 0.78 : 0.96) + flash01 * 0.42;
        tmpEuler.set(0, ring.yaw, -elapsed * 1.35 - i * 0.6);
        tmpQuat.setFromEuler(tmpEuler);
        tmpScale.setScalar(coreScale);
        tmpMat.compose(tmpPos, tmpQuat, tmpScale);
        skyRingCoreInst.setMatrixAt(i, tmpMat);

        tmpColor.setHex(onCooldown && flash01 <= 0.01 ? 0x7dd3fc : 0xfffbeb).multiplyScalar(onCooldown ? 0.65 : 1.35);
        skyRingCoreInst.setColorAt(i, tmpColor);
      }
      skyRingOuterInst.count = SKY_RING_COUNT;
      skyRingOuterInst.visible = true;
      skyRingOuterInst.instanceMatrix.needsUpdate = true;
      if (skyRingOuterInst.instanceColor) skyRingOuterInst.instanceColor.needsUpdate = true;
      skyRingCoreInst.count = SKY_RING_COUNT;
      skyRingCoreInst.visible = true;
      skyRingCoreInst.instanceMatrix.needsUpdate = true;
      if (skyRingCoreInst.instanceColor) skyRingCoreInst.instanceColor.needsUpdate = true;
    } else {
      skyRingOuterInst.visible = false;
      skyRingCoreInst.visible = false;
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
    archSegInst.dispose();
    mailboxBodyInst.dispose();
    mailboxSealInst.dispose();
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
    archSegGeo.dispose();
    archSegMat.dispose();
    mailboxBodyGeo.dispose();
    mailboxBodyMat.dispose();
    mailboxSealGeo.dispose();
    mailboxSealMat.dispose();
    scene.remove(root);
  }

  return {
    spawnCourier,
    setSkyRingsVisible,
    checkSkyRingPass,
    spawnJointMissionArch,
    update,
    dispose,
  };
}
