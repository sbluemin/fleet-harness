import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  Scene,
  SphereGeometry,
} from "three";

import {
  BROOK_BRIDGES,
  BROOK_SPAN_HALF_X,
  brookProfile,
  distanceToBrookEdge,
} from "./brook-geometry.js";

/**
 * 「더 월드」 시냇가 원버튼 힐링 낚시 3D 컨트롤러 (60fps zero-GC 풀링).
 *
 * - 시냇물 수변(`distanceToBrookEdge <= 4.4`) 또는 4개 목교 위에서 `F`로 낚싯대를 던진다.
 * - 3D 대나무 낚싯대 · 곡선 낚싯줄(`Line`) · 빨간/흰 찌 · 수면 파문 링 · 획득 별빛 포물선 연출을
 *   사전 할당 풀로만 구동해 비활성(`idle`) 시 Draw Call 0을 유지한다.
 */

export type WorldFishId =
  | "meadow_minnow"
  | "golden_koi"
  | "starlight_trout"
  | "cherry_loach"
  | "moon_jelly"
  | "rainbow_carp"
  | "star_shell"
  | "message_bottle";

export type WorldFishRarity = "common" | "rare" | "legendary";

export type WorldFishingPhase = "idle" | "waiting" | "bite" | "caught";

export interface WorldFishSpec {
  readonly id: WorldFishId;
  readonly rarity: WorldFishRarity;
  readonly weight: number;
  readonly nightBonusWeight?: number | undefined;
  readonly colorHex: number;
}

export const WORLD_FISH_SPECS: readonly WorldFishSpec[] = [
  { id: "meadow_minnow", rarity: "common", weight: 32, colorHex: 0x38bdf8 },
  { id: "cherry_loach", rarity: "common", weight: 26, colorHex: 0xf472b6 },
  { id: "star_shell", rarity: "common", weight: 20, colorHex: 0xfde68a },
  { id: "golden_koi", rarity: "rare", weight: 14, colorHex: 0xfbbf24 },
  { id: "starlight_trout", rarity: "rare", weight: 12, colorHex: 0x60a5fa },
  { id: "moon_jelly", rarity: "rare", weight: 4, nightBonusWeight: 22, colorHex: 0xc084fc },
  { id: "rainbow_carp", rarity: "legendary", weight: 5, colorHex: 0x34d399 },
  { id: "message_bottle", rarity: "legendary", weight: 6, colorHex: 0xfef08a },
];

export const WORLD_FISH_IDS: readonly WorldFishId[] = WORLD_FISH_SPECS.map((s) => s.id);

export type FishingReelResult =
  | { readonly outcome: "none" }
  | { readonly outcome: "missed" }
  | {
      readonly outcome: "caught";
      readonly fish: WorldFishSpec;
      readonly senderName?: string | undefined;
    };

export interface FishingController {
  isNearWater(px: number, pz: number): boolean;
  startCast(px: number, pz: number, playerYaw: number, groundY?: number): boolean;
  reelIn(isNight: boolean, commodoreNames?: readonly string[]): FishingReelResult;
  cancel(): void;
  getPhase(): WorldFishingPhase;
  update(
    dt: number,
    elapsed: number,
    playerX?: number,
    playerY?: number,
    playerZ?: number,
    playerYaw?: number,
  ): WorldFishingPhase;
  dispose(): void;
}

const LINE_POINTS = 12;
const RIPPLE_COUNT = 3;
const BITE_WINDOW_SEC = 1.8;
const CAUGHT_DISPLAY_SEC = 1.8;

function pickWeightedFish(isNight: boolean): WorldFishSpec {
  let total = 0;
  for (let i = 0; i < WORLD_FISH_SPECS.length; i += 1) {
    const s = WORLD_FISH_SPECS[i]!;
    total += s.weight + (isNight ? (s.nightBonusWeight ?? 0) : 0);
  }
  let roll = Math.random() * total;
  for (let i = 0; i < WORLD_FISH_SPECS.length; i += 1) {
    const s = WORLD_FISH_SPECS[i]!;
    roll -= s.weight + (isNight ? (s.nightBonusWeight ?? 0) : 0);
    if (roll <= 0) return s;
  }
  return WORLD_FISH_SPECS[0]!;
}

export function createFishingController(scene: Scene): FishingController {
  const root = new Group();
  root.name = "the-world-fishing-fx";
  root.visible = false;
  scene.add(root);

  // 1. 3D 대나무 낚싯대 (손잡이 + 대나무 봉 + 황금 끝고리)
  const rodGroup = new Group();
  const rodShaftGeo = new CylinderGeometry(0.016, 0.036, 2.35, 6);
  rodShaftGeo.translate(0, 1.175, 0);
  const rodShaftMat = new MeshStandardMaterial({
    color: 0xd4a359,
    roughness: 0.62,
    metalness: 0.08,
  });
  const rodShaftMesh = new Mesh(rodShaftGeo, rodShaftMat);
  rodGroup.add(rodShaftMesh);

  const rodGripGeo = new CylinderGeometry(0.044, 0.046, 0.42, 6);
  rodGripGeo.translate(0, 0.21, 0);
  const rodGripMat = new MeshStandardMaterial({
    color: 0x6b4423,
    roughness: 0.78,
    metalness: 0.05,
  });
  const rodGripMesh = new Mesh(rodGripGeo, rodGripMat);
  rodGroup.add(rodGripMesh);

  const rodTipGeo = new SphereGeometry(0.032, 6, 5);
  const rodTipMat = new MeshBasicMaterial({ color: 0xfde047 });
  const rodTipMesh = new Mesh(rodTipGeo, rodTipMat);
  rodTipMesh.position.set(0, 2.36, 0);
  rodGroup.add(rodTipMesh);
  root.add(rodGroup);

  // 2. 곡선 낚싯줄 (사전 할당 Float32Array, 0-GC)
  const linePositions = new Float32Array(LINE_POINTS * 3);
  const lineAttr = new BufferAttribute(linePositions, 3);
  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute("position", lineAttr);
  const lineMat = new LineBasicMaterial({
    color: 0xf8fafc,
    transparent: true,
    opacity: 0.82,
  });
  const lineObj = new Line(lineGeo, lineMat);
  lineObj.frustumCulled = false;
  root.add(lineObj);

  // 3. 빨간·흰 찌 (수면 위 둥둥)
  const bobberGroup = new Group();
  const bobberTopGeo = new SphereGeometry(0.13, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.52);
  const bobberTopMat = new MeshStandardMaterial({
    color: 0xef4444,
    roughness: 0.35,
    metalness: 0.05,
    emissive: 0x7f1d1d,
    emissiveIntensity: 0.35,
  });
  const bobberTopMesh = new Mesh(bobberTopGeo, bobberTopMat);
  bobberGroup.add(bobberTopMesh);

  const bobberBotGeo = new SphereGeometry(0.13, 10, 8, 0, Math.PI * 2, Math.PI * 0.48, Math.PI * 0.52);
  const bobberBotMat = new MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 0.38,
    metalness: 0.04,
  });
  const bobberBotMesh = new Mesh(bobberBotGeo, bobberBotMat);
  bobberGroup.add(bobberBotMesh);

  const bobberPinGeo = new CylinderGeometry(0.015, 0.015, 0.24, 5);
  bobberPinGeo.translate(0, 0.17, 0);
  const bobberPinMat = new MeshBasicMaterial({ color: 0xfde047 });
  const bobberPinMesh = new Mesh(bobberPinGeo, bobberPinMat);
  bobberGroup.add(bobberPinMesh);
  root.add(bobberGroup);

  // 4. 수면 파문 링 3개 (입질 시 황금 물보라 확장)
  const rippleGeo = new RingGeometry(0.18, 0.28, 24);
  rippleGeo.rotateX(-Math.PI * 0.5);
  const rippleMats: MeshBasicMaterial[] = [];
  const rippleMeshes: Mesh[] = [];
  for (let i = 0; i < RIPPLE_COUNT; i += 1) {
    const mat = new MeshBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.55,
      side: DoubleSide,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new Mesh(rippleGeo, mat);
    mesh.renderOrder = 6;
    root.add(mesh);
    rippleMats.push(mat);
    rippleMeshes.push(mesh);
  }

  // 5. 낚아 올릴 때 수면에서 튀어 오르는 빛나는 어류 실루엣 구체
  const catchGeo = new SphereGeometry(0.24, 12, 10);
  const catchMat = new MeshBasicMaterial({
    color: 0xfde047,
    transparent: true,
    opacity: 0.92,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const catchMesh = new Mesh(catchGeo, catchMat);
  catchMesh.visible = false;
  catchMesh.renderOrder = 10;
  root.add(catchMesh);

  let phase: WorldFishingPhase = "idle";
  let phaseTimer = 0;
  let phaseElapsed = 0;
  let castPlayerX = 0;
  let castPlayerY = 0.25;
  let castPlayerZ = 0;
  let castPlayerYaw = 0;
  let bobberX = 0;
  let bobberZ = 14.0;
  let bobberBaseY = -0.06;

  function isNearWater(px: number, pz: number): boolean {
    if (distanceToBrookEdge(px, pz) <= 4.4) return true;
    if (Math.abs(px) <= BROOK_SPAN_HALF_X) {
      const bp = brookProfile(px);
      if (Math.abs(pz - bp.centerZ) <= 4.8) return true;
    }
    for (let i = 0; i < BROOK_BRIDGES.length; i += 1) {
      const b = BROOK_BRIDGES[i]!;
      if (Math.hypot(px - b.x, pz - b.z) <= b.halfSpan + 1.8) return true;
    }
    return false;
  }

  function startCast(px: number, pz: number, playerYaw: number, groundY = 0.25): boolean {
    if (!isNearWater(px, pz)) return false;

    const clampedX = Math.max(-BROOK_SPAN_HALF_X + 2, Math.min(BROOK_SPAN_HALF_X - 2, px));
    const bp = brookProfile(clampedX);
    // 시선 방향을 살짝 반영하되 반드시 시냇물 한가운데 수면 위로 떨어지도록 보정
    const aimX = Math.max(
      -BROOK_SPAN_HALF_X + 2,
      Math.min(BROOK_SPAN_HALF_X - 2, clampedX + Math.sin(playerYaw) * 2.4),
    );
    const bpAim = brookProfile(aimX);
    let targetX = aimX;
    let targetZ = bpAim.centerZ;
    const distToAim = Math.hypot(targetX - px, targetZ - pz);
    if (distToAim < 2.2) {
      // 목교 바로 위 등 수면 바로 위일 땐 시선 옆 강줄기 쪽으로 3.4m 투척
      const sideSign = Math.sin(playerYaw) >= 0 ? 1 : -1;
      targetX = Math.max(-BROOK_SPAN_HALF_X + 2, Math.min(BROOK_SPAN_HALF_X - 2, px + sideSign * 3.6));
      targetZ = brookProfile(targetX).centerZ;
    } else if (distToAim > 7.5) {
      targetX = clampedX;
      targetZ = bp.centerZ;
    }

    castPlayerX = px;
    castPlayerY = groundY;
    castPlayerZ = pz;
    castPlayerYaw = Math.atan2(targetX - px, targetZ - pz);
    bobberX = targetX;
    bobberZ = targetZ;
    bobberBaseY = -0.06;

    phase = "waiting";
    phaseTimer = 1.7 + Math.random() * 2.1;
    phaseElapsed = 0;
    catchMesh.visible = false;
    bobberGroup.visible = true;
    lineObj.visible = true;
    rodGroup.visible = true;
    root.visible = true;
    return true;
  }

  function cancel(): void {
    phase = "idle";
    phaseTimer = 0;
    phaseElapsed = 0;
    catchMesh.visible = false;
    root.visible = false;
  }

  function reelIn(isNight: boolean, commodoreNames: readonly string[] = []): FishingReelResult {
    if (phase === "waiting") {
      cancel();
      return { outcome: "missed" };
    }
    if (phase === "bite") {
      const fish = pickWeightedFish(isNight);
      const senderName = fish.id === "message_bottle" && commodoreNames.length > 0
        ? commodoreNames[Math.floor(Math.random() * commodoreNames.length)]
        : undefined;
      phase = "caught";
      phaseTimer = CAUGHT_DISPLAY_SEC;
      phaseElapsed = 0;
      catchMat.color.setHex(fish.colorHex);
      catchMesh.visible = true;
      bobberGroup.visible = false;
      lineObj.visible = false;
      return {
        outcome: "caught",
        fish,
        ...(senderName ? { senderName } : {}),
      };
    }
    return { outcome: "none" };
  }

  function update(
    dt: number,
    elapsed: number,
    playerX?: number,
    playerY?: number,
    playerZ?: number,
    playerYaw?: number,
  ): WorldFishingPhase {
    if (phase === "idle") {
      root.visible = false;
      return "idle";
    }

    const safeDt = Math.min(0.05, Math.max(0, dt));
    phaseElapsed += safeDt;
    phaseTimer -= safeDt;

    if (playerX !== undefined) castPlayerX = playerX;
    if (playerY !== undefined) castPlayerY = playerY;
    if (playerZ !== undefined) castPlayerZ = playerZ;
    if (playerYaw !== undefined && phase !== "caught") {
      // 낚싯대는 물 위 찌 방향을 자연스럽게 겨눈다
      castPlayerYaw = Math.atan2(bobberX - castPlayerX, bobberZ - castPlayerZ);
    }

    if (phase === "waiting" && phaseTimer <= 0) {
      phase = "bite";
      phaseTimer = BITE_WINDOW_SEC;
      phaseElapsed = 0;
    } else if (phase === "bite" && phaseTimer <= 0) {
      cancel();
      return "idle";
    } else if (phase === "caught" && phaseTimer <= 0) {
      cancel();
      return "idle";
    }

    // 1) 낚싯대 위치 및 기울기 갱신 (제독 오른손 앞쪽)
    const dirX = Math.sin(castPlayerYaw);
    const dirZ = Math.cos(castPlayerYaw);
    const rightX = Math.cos(castPlayerYaw);
    const rightZ = -Math.sin(castPlayerYaw);

    const handX = castPlayerX + rightX * 0.34 + dirX * 0.22;
    const handY = castPlayerY + 0.68;
    const handZ = castPlayerZ + rightZ * 0.34 + dirZ * 0.22;

    const rodPitch = phase === "bite"
      ? 0.88 + Math.sin(elapsed * 28) * 0.08
      : phase === "caught"
        ? 0.42
        : 0.78 + Math.sin(elapsed * 2.1) * 0.03;

    rodGroup.position.set(handX, handY, handZ);
    rodGroup.rotation.set(0, castPlayerYaw, 0);
    rodGroup.rotateX(rodPitch);

    // 낚싯대 끝 월드 좌표 (길이 2.36m, 앞쪽 +Z & 위쪽 +Y 기울기)
    const sinP = Math.sin(rodPitch);
    const cosP = Math.cos(rodPitch);
    const tipX = handX + dirX * (2.36 * sinP);
    const tipY = handY + 2.36 * cosP;
    const tipZ = handZ + dirZ * (2.36 * sinP);

    if (phase === "caught") {
      // 낚아 올린 빛나는 물고기가 수면 → 제독 머리 위로 경쾌한 포물선 점프!
      const u = Math.min(1, phaseElapsed / 0.65);
      const ease = 1 - Math.pow(1 - u, 2.2);
      const fx = bobberX + (castPlayerX + dirX * 0.85 - bobberX) * ease;
      const fz = bobberZ + (castPlayerZ + dirZ * 0.85 - bobberZ) * ease;
      const fy = bobberBaseY + (castPlayerY + 1.55 - bobberBaseY) * ease + Math.sin(u * Math.PI) * 1.65;
      catchMesh.position.set(fx, fy, fz);
      const pulse = 0.95 + Math.sin(elapsed * 14) * 0.16;
      catchMesh.scale.set(pulse * 1.25, pulse * 0.82, pulse * 0.95);
      catchMesh.rotation.y = elapsed * 5.2;
      for (let i = 0; i < RIPPLE_COUNT; i += 1) {
        rippleMeshes[i]!.visible = false;
      }
      return phase;
    }

    // 2) 찌 애니메이션 (대기: 잔잔한 둥둥 / 입질: 퐁당퐁당 강한 흔들림!)
    const isBite = phase === "bite";
    const bobOffsetY = isBite
      ? -0.07 + Math.sin(elapsed * 26.0) * 0.13
      : Math.sin(elapsed * 3.2) * 0.042;
    const jitterX = isBite ? Math.sin(elapsed * 31.0) * 0.07 : 0;
    const jitterZ = isBite ? Math.cos(elapsed * 27.0) * 0.07 : 0;
    const curBobX = bobberX + jitterX;
    const curBobY = bobberBaseY + bobOffsetY;
    const curBobZ = bobberZ + jitterZ;

    bobberGroup.position.set(curBobX, curBobY, curBobZ);
    bobberGroup.rotation.set(
      isBite ? Math.sin(elapsed * 22) * 0.38 : Math.sin(elapsed * 2.3) * 0.08,
      elapsed * (isBite ? 4.5 : 0.7),
      isBite ? Math.cos(elapsed * 19) * 0.35 : Math.cos(elapsed * 1.9) * 0.08,
    );

    // 3) 곡선 낚싯줄 정점 업데이트 (입질 시 팽팽해짐)
    const sag = isBite ? 0.08 : 0.42;
    const midX = (tipX + curBobX) * 0.5;
    const midY = (tipY + curBobY) * 0.5 - sag;
    const midZ = (tipZ + curBobZ) * 0.5;
    for (let i = 0; i < LINE_POINTS; i += 1) {
      const t = i / (LINE_POINTS - 1);
      const inv = 1 - t;
      linePositions[i * 3] = inv * inv * tipX + 2 * inv * t * midX + t * t * curBobX;
      linePositions[i * 3 + 1] = inv * inv * tipY + 2 * inv * t * midY + t * t * (curBobY + 0.14);
      linePositions[i * 3 + 2] = inv * inv * tipZ + 2 * inv * t * midZ + t * t * curBobZ;
    }
    lineAttr.needsUpdate = true;

    // 4) 수면 파문 링 3개 확장
    const rippleSpeed = isBite ? 1.85 : 0.65;
    for (let i = 0; i < RIPPLE_COUNT; i += 1) {
      const mesh = rippleMeshes[i]!;
      const mat = rippleMats[i]!;
      const rT = (elapsed * rippleSpeed + i / RIPPLE_COUNT) % 1;
      const scale = 0.75 + rT * (isBite ? 5.2 : 2.6);
      mesh.visible = true;
      mesh.position.set(curBobX, bobberBaseY + 0.04, curBobZ);
      mesh.scale.set(scale, 1, scale);
      mat.color.setHex(isBite ? 0xfde047 : 0xe0f2fe);
      mat.opacity = (1 - rT) * (isBite ? 0.82 : 0.42);
    }

    return phase;
  }

  function dispose(): void {
    rodShaftGeo.dispose();
    rodShaftMat.dispose();
    rodGripGeo.dispose();
    rodGripMat.dispose();
    rodTipGeo.dispose();
    rodTipMat.dispose();
    lineGeo.dispose();
    lineMat.dispose();
    bobberTopGeo.dispose();
    bobberTopMat.dispose();
    bobberBotGeo.dispose();
    bobberBotMat.dispose();
    bobberPinGeo.dispose();
    bobberPinMat.dispose();
    rippleGeo.dispose();
    for (const mat of rippleMats) mat.dispose();
    catchGeo.dispose();
    catchMat.dispose();
    scene.remove(root);
  }

  return {
    isNearWater,
    startCast,
    reelIn,
    cancel,
    getPhase: () => phase,
    update,
    dispose,
  };
}
