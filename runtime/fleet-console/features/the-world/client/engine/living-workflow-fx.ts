import {
  AdditiveBlending,
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

export interface LivingWorkflowFx {
  /** 두 지점 사이로 포물선(2차 베지어) 별빛 전령 구슬을 발사한다. */
  spawnCourier(from: LivingWorkflowPoint, to: LivingWorkflowPoint, colorHex?: number): void;
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
const MAX_TRAIL_BEADS = 128;
const MAX_CRYSTALS = 16;

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
  const tmpColor = new Color();
  const tmpColorA = new Color();
  const tmpColorB = new Color();

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
    scene.remove(root);
  }

  return {
    spawnCourier,
    update,
    dispose,
  };
}
