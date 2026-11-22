import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
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
  Vector3,
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
 * - 5단계 시네마틱 낚시 흐름: `idle` → `casting`(0.58s 백스윙·포워드 휘두름·포물선 찌 투척·착수) → `waiting` → `bite` → `caught`.
 * - 다관절 3세그먼트 휘어지는 대나무 낚싯대 · 실시간 곡선 낚싯줄 · 빨간/흰 찌 · 3중 수면 파문 링 ·
 *   4종 풀링 3D 포획 모델(물고기·유리병 편지·달빛 해파리·별조개)로 비활성 시 Draw Call 0을 유지한다.
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

export type FishingInternalPhase = "idle" | "casting" | "waiting" | "bite" | "caught";

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

export interface CompanionAnglerPose {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

export interface FishingController {
  isNearWater(px: number, pz: number): boolean;
  startCast(px: number, pz: number, playerYaw: number, groundY?: number): boolean;
  reelIn(isNight: boolean, commodoreNames?: readonly string[]): FishingReelResult;
  cancel(): void;
  getPhase(): FishingInternalPhase;
  getUiPhase(): WorldFishingPhase;
  getCastTargetYaw(): number;
  getCastProgress(): number;
  /** 제독이 낚시 중일 때 최대 3명의 동행 사령관이 강가에서 함께 미니 낚싯대·찌를 드리우도록 동기화한다 (0-GC 풀링). */
  syncCompanionAnglers(anglers: readonly CompanionAnglerPose[], elapsedSec: number): void;
  update(
    dt: number,
    elapsed: number,
    playerX?: number,
    playerY?: number,
    playerZ?: number,
    playerYaw?: number,
    onBobberSplash?: (x: number, y: number, z: number) => void,
  ): FishingInternalPhase;
  dispose(): void;
}

const LINE_POINTS = 14;
const COMPANION_LINE_POINTS = 8;
const MAX_COMPANION_ANGLERS = 3;
const RIPPLE_COUNT = 3;
const CAST_DURATION_SEC = 0.58;
const CAST_BACKSWING_END = 0.22;
const CAST_SWING_END = 0.34;
const CAST_RELEASE_TIME = 0.28;
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

function smoothstep01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

export function createFishingController(scene: Scene): FishingController {
  const root = new Group();
  root.name = "the-world-fishing-fx";
  root.visible = false;
  scene.add(root);

  // 1. 다관절 3세그먼트 휘어지는 대나무 낚싯대 (손잡이 + 하단/중단/상단 탄성 휨 + 황금 끝고리)
  const rodGroup = new Group();
  const rodGripGeo = new CylinderGeometry(0.044, 0.048, 0.38, 6);
  rodGripGeo.translate(0, 0.19, 0);
  const rodGripMat = new MeshStandardMaterial({
    color: 0x6b4423,
    roughness: 0.78,
    metalness: 0.05,
  });
  rodGroup.add(new Mesh(rodGripGeo, rodGripMat));

  const rodSegMat = new MeshStandardMaterial({
    color: 0xd4a359,
    roughness: 0.58,
    metalness: 0.08,
  });
  const rodBandMat = new MeshStandardMaterial({
    color: 0x3b2614,
    roughness: 0.72,
    metalness: 0.12,
  });

  const rodSeg1Geo = new CylinderGeometry(0.028, 0.038, 0.90, 6);
  rodSeg1Geo.translate(0, 0.45, 0);
  const rodSeg1Mesh = new Mesh(rodSeg1Geo, rodSegMat);
  rodSeg1Mesh.position.y = 0.06;
  rodGroup.add(rodSeg1Mesh);

  const rodBandGeo = new CylinderGeometry(0.032, 0.032, 0.055, 6);
  const rodBand1 = new Mesh(rodBandGeo, rodBandMat);
  rodBand1.position.y = 0.95;
  rodGroup.add(rodBand1);

  const rodMidJoint = new Group();
  rodMidJoint.position.y = 0.96;
  const rodSeg2Geo = new CylinderGeometry(0.020, 0.028, 0.80, 6);
  rodSeg2Geo.translate(0, 0.40, 0);
  rodMidJoint.add(new Mesh(rodSeg2Geo, rodSegMat));

  const rodBand2 = new Mesh(rodBandGeo, rodBandMat);
  rodBand2.scale.set(0.78, 1, 0.78);
  rodBand2.position.y = 0.79;
  rodMidJoint.add(rodBand2);
  rodGroup.add(rodMidJoint);

  const rodTipJoint = new Group();
  rodTipJoint.position.y = 0.80;
  const rodSeg3Geo = new CylinderGeometry(0.011, 0.020, 0.72, 6);
  rodSeg3Geo.translate(0, 0.36, 0);
  rodTipJoint.add(new Mesh(rodSeg3Geo, rodSegMat));

  const rodTipGeo = new SphereGeometry(0.034, 6, 5);
  const rodTipMat = new MeshBasicMaterial({ color: 0xfde047 });
  const rodTipMesh = new Mesh(rodTipGeo, rodTipMat);
  rodTipMesh.position.set(0, 0.73, 0);
  rodTipJoint.add(rodTipMesh);
  rodMidJoint.add(rodTipJoint);
  root.add(rodGroup);

  // 2. 곡선 낚싯줄 (사전 할당 Float32Array, 0-GC)
  const linePositions = new Float32Array(LINE_POINTS * 3);
  const lineAttr = new BufferAttribute(linePositions, 3);
  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute("position", lineAttr);
  const lineMat = new LineBasicMaterial({
    color: 0xf8fafc,
    transparent: true,
    opacity: 0.84,
  });
  const lineObj = new Line(lineGeo, lineMat);
  lineObj.frustumCulled = false;
  root.add(lineObj);

  // 3. 빨간·흰 찌 (수면 위 둥둥 · 캐스팅 시 포물선 투척!)
  const bobberGroup = new Group();
  const bobberTopGeo = new SphereGeometry(0.135, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.52);
  const bobberTopMat = new MeshStandardMaterial({
    color: 0xef4444,
    roughness: 0.35,
    metalness: 0.05,
    emissive: 0x7f1d1d,
    emissiveIntensity: 0.38,
  });
  bobberGroup.add(new Mesh(bobberTopGeo, bobberTopMat));

  const bobberBotGeo = new SphereGeometry(0.135, 10, 8, 0, Math.PI * 2, Math.PI * 0.48, Math.PI * 0.52);
  const bobberBotMat = new MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 0.38,
    metalness: 0.04,
  });
  bobberGroup.add(new Mesh(bobberBotGeo, bobberBotMat));

  const bobberPinGeo = new CylinderGeometry(0.015, 0.015, 0.24, 5);
  bobberPinGeo.translate(0, 0.17, 0);
  const bobberPinMat = new MeshBasicMaterial({ color: 0xfde047 });
  bobberGroup.add(new Mesh(bobberPinGeo, bobberPinMat));
  root.add(bobberGroup);

  // 4. 수면 파문 링 3개 (착수 스플래시 & 입질 황금 물보라 확장)
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

  // 5. 4종 풀링 3D 포획 모델 (물고기 · 유리병 편지 · 달빛 해파리 · 별조개, 0-GC)
  const catchRoot = new Group();
  catchRoot.visible = false;
  root.add(catchRoot);

  // 5-A. 3D 유선형 물고기 (몸통 + 등/가슴 지느러미 + 흔들리는 V자 꼬리 + 양쪽 검은 눈)
  const catchFishGroup = new Group();
  const fishBodyGeo = new SphereGeometry(0.22, 14, 10);
  const fishBodyMat = new MeshStandardMaterial({
    color: 0x38bdf8,
    emissive: 0x0c4a6e,
    emissiveIntensity: 0.38,
    roughness: 0.28,
    metalness: 0.18,
  });
  const fishBodyMesh = new Mesh(fishBodyGeo, fishBodyMat);
  fishBodyMesh.scale.set(0.62, 0.78, 1.55);
  catchFishGroup.add(fishBodyMesh);

  const fishFinGeo = new ConeGeometry(0.11, 0.26, 4);
  const fishFinMat = new MeshStandardMaterial({
    color: 0xfef08a,
    emissive: 0x78350f,
    emissiveIntensity: 0.28,
    roughness: 0.35,
    metalness: 0.1,
  });
  const fishDorsalFin = new Mesh(fishFinGeo, fishFinMat);
  fishDorsalFin.position.set(0, 0.19, -0.04);
  fishDorsalFin.rotation.x = -0.58;
  fishDorsalFin.scale.set(0.45, 1.0, 1.15);
  catchFishGroup.add(fishDorsalFin);

  const fishLeftFin = new Mesh(fishFinGeo, fishFinMat);
  fishLeftFin.position.set(-0.14, -0.04, 0.08);
  fishLeftFin.rotation.set(0.35, 0, 1.15);
  fishLeftFin.scale.set(0.42, 0.72, 0.72);
  catchFishGroup.add(fishLeftFin);

  const fishRightFin = new Mesh(fishFinGeo, fishFinMat);
  fishRightFin.position.set(0.14, -0.04, 0.08);
  fishRightFin.rotation.set(0.35, 0, -1.15);
  fishRightFin.scale.set(0.42, 0.72, 0.72);
  catchFishGroup.add(fishRightFin);

  const fishTailPivot = new Group();
  fishTailPivot.position.set(0, 0, -0.31);
  const fishTailUpper = new Mesh(fishFinGeo, fishFinMat);
  fishTailUpper.position.set(0, 0.085, -0.11);
  fishTailUpper.rotation.x = -1.12;
  fishTailUpper.scale.set(0.32, 0.98, 0.85);
  fishTailPivot.add(fishTailUpper);
  const fishTailLower = new Mesh(fishFinGeo, fishFinMat);
  fishTailLower.position.set(0, -0.085, -0.11);
  fishTailLower.rotation.x = -2.02;
  fishTailLower.scale.set(0.32, 0.98, 0.85);
  fishTailPivot.add(fishTailLower);
  catchFishGroup.add(fishTailPivot);

  const fishEyeGeo = new SphereGeometry(0.038, 8, 6);
  const fishEyeMat = new MeshBasicMaterial({ color: 0x0f172a });
  const fishEyeL = new Mesh(fishEyeGeo, fishEyeMat);
  fishEyeL.position.set(-0.105, 0.045, 0.21);
  catchFishGroup.add(fishEyeL);
  const fishEyeR = new Mesh(fishEyeGeo, fishEyeMat);
  fishEyeR.position.set(0.105, 0.045, 0.21);
  catchFishGroup.add(fishEyeR);
  catchRoot.add(catchFishGroup);

  // 5-B. 3D 유리병 편지 (반투명 에메랄드 유리병 + 코르크 마개 + 내부 말린 양피지)
  const catchBottleGroup = new Group();
  const bottleBodyGeo = new CylinderGeometry(0.125, 0.145, 0.42, 12);
  const bottleGlassMat = new MeshStandardMaterial({
    color: 0x6ee7b7,
    emissive: 0x065f46,
    emissiveIntensity: 0.35,
    roughness: 0.14,
    metalness: 0.08,
    transparent: true,
    opacity: 0.62,
  });
  catchBottleGroup.add(new Mesh(bottleBodyGeo, bottleGlassMat));

  const bottleNeckGeo = new CylinderGeometry(0.055, 0.11, 0.16, 10);
  const bottleNeckMesh = new Mesh(bottleNeckGeo, bottleGlassMat);
  bottleNeckMesh.position.y = 0.28;
  catchBottleGroup.add(bottleNeckMesh);

  const bottleCorkGeo = new CylinderGeometry(0.054, 0.048, 0.09, 8);
  const bottleCorkMat = new MeshStandardMaterial({ color: 0xb47843, roughness: 0.85 });
  const bottleCorkMesh = new Mesh(bottleCorkGeo, bottleCorkMat);
  bottleCorkMesh.position.y = 0.38;
  catchBottleGroup.add(bottleCorkMesh);

  const scrollGeo = new CylinderGeometry(0.056, 0.056, 0.27, 8);
  const scrollMat = new MeshStandardMaterial({
    color: 0xfef3c7,
    emissive: 0xfde68a,
    emissiveIntensity: 0.42,
    roughness: 0.65,
  });
  const scrollMesh = new Mesh(scrollGeo, scrollMat);
  scrollMesh.position.set(0.01, -0.02, 0);
  scrollMesh.rotation.z = 0.18;
  catchBottleGroup.add(scrollMesh);
  catchBottleGroup.rotation.z = 0.28;
  catchRoot.add(catchBottleGroup);

  // 5-C. 3D 달빛 해파리 (반투명 발광 보라 갓 + 내부 발광 핵 + 흔들리는 촉수 4가닥)
  const catchJellyGroup = new Group();
  const jellyBellGeo = new SphereGeometry(0.24, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.58);
  const jellyBellMat = new MeshStandardMaterial({
    color: 0xd8b4fe,
    emissive: 0x9333ea,
    emissiveIntensity: 0.72,
    roughness: 0.2,
    transparent: true,
    opacity: 0.76,
    side: DoubleSide,
  });
  const jellyBellMesh = new Mesh(jellyBellGeo, jellyBellMat);
  jellyBellMesh.position.y = 0.06;
  catchJellyGroup.add(jellyBellMesh);

  const jellyCoreGeo = new SphereGeometry(0.105, 10, 8);
  const jellyCoreMat = new MeshBasicMaterial({
    color: 0xf5d0fe,
    transparent: true,
    opacity: 0.88,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const jellyCoreMesh = new Mesh(jellyCoreGeo, jellyCoreMat);
  jellyCoreMesh.position.y = 0.11;
  catchJellyGroup.add(jellyCoreMesh);

  const tentacleGeo = new CylinderGeometry(0.018, 0.008, 0.42, 6);
  tentacleGeo.translate(0, -0.21, 0);
  const tentacleMat = new MeshBasicMaterial({
    color: 0xe9d5ff,
    transparent: true,
    opacity: 0.84,
  });
  const jellyTentacles: Mesh[] = [];
  for (let ti = 0; ti < 4; ti += 1) {
    const ang = (ti / 4) * Math.PI * 2 + 0.4;
    const tMesh = new Mesh(tentacleGeo, tentacleMat);
    tMesh.position.set(Math.cos(ang) * 0.11, 0.04, Math.sin(ang) * 0.11);
    catchJellyGroup.add(tMesh);
    jellyTentacles.push(tMesh);
  }
  catchRoot.add(catchJellyGroup);

  // 5-D. 3D 별조개 (부채꼴 황금 조개껍질 2쪽 + 중앙 빛나는 진주)
  const catchShellGroup = new Group();
  const shellValveGeo = new CylinderGeometry(0.24, 0.08, 0.065, 7);
  const shellValveMat = new MeshStandardMaterial({
    color: 0xfcd34d,
    emissive: 0xb45309,
    emissiveIntensity: 0.35,
    roughness: 0.32,
    metalness: 0.25,
  });
  const shellLower = new Mesh(shellValveGeo, shellValveMat);
  shellLower.position.set(0, -0.05, 0);
  shellLower.rotation.x = 0.25;
  shellLower.scale.set(1.12, 1.0, 0.92);
  catchShellGroup.add(shellLower);

  const shellUpper = new Mesh(shellValveGeo, shellValveMat);
  shellUpper.position.set(0, 0.09, -0.06);
  shellUpper.rotation.x = -0.82;
  shellUpper.scale.set(1.12, 1.0, 0.92);
  catchShellGroup.add(shellUpper);

  const pearlGeo = new SphereGeometry(0.095, 10, 8);
  const pearlMat = new MeshStandardMaterial({
    color: 0xfffbeb,
    emissive: 0xfef3c7,
    emissiveIntensity: 0.65,
    roughness: 0.12,
    metalness: 0.18,
  });
  const pearlMesh = new Mesh(pearlGeo, pearlMat);
  pearlMesh.position.set(0, 0.03, 0.02);
  catchShellGroup.add(pearlMesh);
  catchRoot.add(catchShellGroup);

  const tipWorldScratch = new Vector3();

  // 6. 동행 사령관 함께 낚시 미니 낚싯대 풀 (최대 3인, 0-GC, 비활성 시 Draw Call 0)
  const companionRoot = new Group();
  companionRoot.name = "the-world-companion-fishing-fx";
  companionRoot.visible = false;
  scene.add(companionRoot);

  const miniRodGeo = new CylinderGeometry(0.011, 0.028, 1.48, 6);
  miniRodGeo.translate(0, 0.74, 0);

  interface CompanionAnglerSlot {
    readonly group: Group;
    readonly rodGroup: Group;
    readonly tipMesh: Mesh;
    readonly linePositions: Float32Array;
    readonly lineAttr: BufferAttribute;
    readonly lineGeo: BufferGeometry;
    readonly bobberGroup: Group;
    readonly rippleMesh: Mesh;
    readonly rippleMat: MeshBasicMaterial;
  }

  const companionSlots: CompanionAnglerSlot[] = [];
  for (let i = 0; i < MAX_COMPANION_ANGLERS; i += 1) {
    const slotGroup = new Group();
    slotGroup.visible = false;

    const cRodGroup = new Group();
    const cGrip = new Mesh(rodGripGeo, rodGripMat);
    cGrip.scale.set(0.75, 0.68, 0.75);
    cRodGroup.add(cGrip);
    const cShaft = new Mesh(miniRodGeo, rodSegMat);
    cShaft.position.y = 0.08;
    cRodGroup.add(cShaft);
    const cTip = new Mesh(rodTipGeo, rodTipMat);
    cTip.scale.setScalar(0.75);
    cTip.position.set(0, 1.56, 0);
    cRodGroup.add(cTip);
    slotGroup.add(cRodGroup);

    const cLinePositions = new Float32Array(COMPANION_LINE_POINTS * 3);
    const cLineAttr = new BufferAttribute(cLinePositions, 3);
    const cLineGeo = new BufferGeometry();
    cLineGeo.setAttribute("position", cLineAttr);
    const cLineObj = new Line(cLineGeo, lineMat);
    cLineObj.frustumCulled = false;
    slotGroup.add(cLineObj);

    const cBobber = new Group();
    cBobber.add(new Mesh(bobberTopGeo, bobberTopMat));
    cBobber.add(new Mesh(bobberBotGeo, bobberBotMat));
    cBobber.add(new Mesh(bobberPinGeo, bobberPinMat));
    cBobber.scale.setScalar(0.78);
    slotGroup.add(cBobber);

    const cRippleMat = new MeshBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.36,
      side: DoubleSide,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const cRippleMesh = new Mesh(rippleGeo, cRippleMat);
    cRippleMesh.renderOrder = 6;
    slotGroup.add(cRippleMesh);

    companionRoot.add(slotGroup);
    companionSlots.push({
      group: slotGroup,
      rodGroup: cRodGroup,
      tipMesh: cTip,
      linePositions: cLinePositions,
      lineAttr: cLineAttr,
      lineGeo: cLineGeo,
      bobberGroup: cBobber,
      rippleMesh: cRippleMesh,
      rippleMat: cRippleMat,
    });
  }

  let phase: FishingInternalPhase = "idle";
  let phaseTimer = 0;
  let phaseElapsed = 0;
  let splashRippleTimer = 0;
  let releaseCaptured = false;
  let launchX = 0;
  let launchY = 1.6;
  let launchZ = 0;
  let castPlayerX = 0;
  let castPlayerY = 0.25;
  let castPlayerZ = 0;
  let castPlayerYaw = 0;
  let bobberX = 0;
  let bobberZ = 14.0;
  let bobberBaseY = -0.06;
  let activeCatchKind: "fish" | "bottle" | "jelly" | "shell" = "fish";

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
    const aimX = Math.max(
      -BROOK_SPAN_HALF_X + 2,
      Math.min(BROOK_SPAN_HALF_X - 2, clampedX + Math.sin(playerYaw) * 2.4),
    );
    const bpAim = brookProfile(aimX);
    let targetX = aimX;
    let targetZ = bpAim.centerZ;
    const distToAim = Math.hypot(targetX - px, targetZ - pz);
    if (distToAim < 2.2) {
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

    phase = "casting";
    phaseTimer = CAST_DURATION_SEC;
    phaseElapsed = 0;
    splashRippleTimer = 0;
    releaseCaptured = false;
    catchRoot.visible = false;
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
    splashRippleTimer = 0;
    releaseCaptured = false;
    catchRoot.visible = false;
    root.visible = false;
  }

  function configureCatchModel(fish: WorldFishSpec): void {
    catchFishGroup.visible = false;
    catchBottleGroup.visible = false;
    catchJellyGroup.visible = false;
    catchShellGroup.visible = false;

    if (fish.id === "message_bottle") {
      activeCatchKind = "bottle";
      catchBottleGroup.visible = true;
    } else if (fish.id === "moon_jelly") {
      activeCatchKind = "jelly";
      catchJellyGroup.visible = true;
    } else if (fish.id === "star_shell") {
      activeCatchKind = "shell";
      catchShellGroup.visible = true;
    } else {
      activeCatchKind = "fish";
      fishBodyMat.color.setHex(fish.colorHex);
      fishBodyMat.emissive.setHex(fish.colorHex).multiplyScalar(fish.rarity === "legendary" ? 0.45 : 0.22);
      fishFinMat.color.setHex(fish.id === "golden_koi" || fish.id === "rainbow_carp" ? 0xfef08a : 0xe0f2fe);
      catchFishGroup.visible = true;
    }
  }

  function reelIn(isNight: boolean, commodoreNames: readonly string[] = []): FishingReelResult {
    if (phase === "casting") {
      return { outcome: "none" };
    }
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
      configureCatchModel(fish);
      catchRoot.visible = true;
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

  function getUiPhase(): WorldFishingPhase {
    return phase === "casting" ? "waiting" : phase;
  }

  function getCastProgress(): number {
    if (phase !== "casting") return 0;
    return Math.max(0, Math.min(1, phaseElapsed / CAST_DURATION_SEC));
  }

  function update(
    dt: number,
    elapsed: number,
    playerX?: number,
    playerY?: number,
    playerZ?: number,
    _playerYaw?: number,
    onBobberSplash?: (x: number, y: number, z: number) => void,
  ): FishingInternalPhase {
    if (phase === "idle") {
      root.visible = false;
      return "idle";
    }

    const safeDt = Math.min(0.05, Math.max(0, dt));
    phaseElapsed += safeDt;
    phaseTimer -= safeDt;
    if (splashRippleTimer > 0) {
      splashRippleTimer = Math.max(0, splashRippleTimer - safeDt);
    }

    if (playerX !== undefined) castPlayerX = playerX;
    if (playerY !== undefined) castPlayerY = playerY;
    if (playerZ !== undefined) castPlayerZ = playerZ;
    if (phase !== "caught") {
      castPlayerYaw = Math.atan2(bobberX - castPlayerX, bobberZ - castPlayerZ);
    }

    // 단계 전환
    if (phase === "casting" && phaseTimer <= 0) {
      phase = "waiting";
      phaseTimer = 1.7 + Math.random() * 2.1;
      phaseElapsed = 0;
      splashRippleTimer = 0.95;
      onBobberSplash?.(bobberX, bobberBaseY + 0.08, bobberZ);
    } else if (phase === "waiting" && phaseTimer <= 0) {
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

    // 1) 다관절 3세그먼트 낚싯대 위치(제독 오른 별 팔 끝 밀착) 및 동적 휨 각도
    const dirX = Math.sin(castPlayerYaw);
    const dirZ = Math.cos(castPlayerYaw);
    const rightX = Math.cos(castPlayerYaw);
    const rightZ = -Math.sin(castPlayerYaw);

    const handX = castPlayerX + rightX * 0.48 + dirX * 0.24;
    const handY = castPlayerY + 0.78;
    const handZ = castPlayerZ + rightZ * 0.48 + dirZ * 0.24;

    let rodPitch = 0.74;
    let rodBend = 0.08;
    if (phase === "casting") {
      const t = phaseElapsed;
      if (t < CAST_BACKSWING_END) {
        const u = smoothstep01(t / CAST_BACKSWING_END);
        rodPitch = 0.52 + (-0.68 - 0.52) * u;
        rodBend = -0.24 * Math.sin(u * Math.PI);
      } else if (t < CAST_SWING_END) {
        const u = smoothstep01((t - CAST_BACKSWING_END) / (CAST_SWING_END - CAST_BACKSWING_END));
        rodPitch = -0.68 + (0.92 - -0.68) * u;
        rodBend = 0.42 * Math.sin(u * Math.PI);
      } else {
        const u = Math.min(1, (t - CAST_SWING_END) / (CAST_DURATION_SEC - CAST_SWING_END));
        rodPitch = 0.92 + (0.74 - 0.92) * smoothstep01(u);
        rodBend = 0.14 + Math.sin(u * Math.PI * 2.5) * (1 - u) * 0.18;
      }
    } else if (phase === "waiting") {
      rodPitch = 0.74 + Math.sin(elapsed * 2.1) * 0.026;
      rodBend = 0.09 + Math.sin(elapsed * 2.4) * 0.03;
    } else if (phase === "bite") {
      rodPitch = 0.62 + Math.sin(elapsed * 26.0) * 0.075;
      rodBend = 0.52 + Math.sin(elapsed * 29.0) * 0.16;
    } else {
      rodPitch = 0.34;
      rodBend = 0.18;
    }

    rodGroup.position.set(handX, handY, handZ);
    rodGroup.rotation.set(0, castPlayerYaw, 0);
    rodGroup.rotateX(rodPitch);
    rodMidJoint.rotation.x = rodBend * 0.52;
    rodTipJoint.rotation.x = rodBend * 0.92;
    rodGroup.updateMatrixWorld(true);
    rodTipMesh.getWorldPosition(tipWorldScratch);

    const tipX = tipWorldScratch.x;
    const tipY = tipWorldScratch.y;
    const tipZ = tipWorldScratch.z;

    // 2) 포획 모델 포물선 점프 연출
    if (phase === "caught") {
      const u = Math.min(1, phaseElapsed / 0.68);
      const ease = 1 - Math.pow(1 - u, 2.2);
      const fx = bobberX + (castPlayerX + dirX * 0.92 - bobberX) * ease;
      const fz = bobberZ + (castPlayerZ + dirZ * 0.92 - bobberZ) * ease;
      const fy = bobberBaseY + (castPlayerY + 1.62 - bobberBaseY) * ease + Math.sin(u * Math.PI) * 1.72;
      catchRoot.position.set(fx, fy, fz);
      catchRoot.rotation.y = castPlayerYaw + Math.PI + Math.sin(elapsed * 3.8) * 0.38;

      if (activeCatchKind === "fish") {
        fishTailPivot.rotation.y = Math.sin(elapsed * 26.0) * 0.45;
        catchFishGroup.rotation.z = Math.sin(elapsed * 18.0) * 0.14;
      } else if (activeCatchKind === "jelly") {
        const bellPulse = 1.0 + Math.sin(elapsed * 8.5) * 0.10;
        catchJellyGroup.scale.set(bellPulse, 1 / Math.sqrt(bellPulse), bellPulse);
        for (let ti = 0; ti < jellyTentacles.length; ti += 1) {
          const tm = jellyTentacles[ti]!;
          tm.rotation.x = Math.sin(elapsed * 9.0 + ti * 1.4) * 0.34;
          tm.rotation.z = Math.cos(elapsed * 7.5 + ti * 1.1) * 0.28;
        }
      } else if (activeCatchKind === "bottle") {
        catchBottleGroup.rotation.y = elapsed * 2.4;
      } else {
        catchShellGroup.rotation.y = elapsed * 2.6;
      }

      for (let i = 0; i < RIPPLE_COUNT; i += 1) {
        rippleMeshes[i]!.visible = false;
      }
      return phase;
    }

    // 3) 찌 위치 & 곡선 낚싯줄 업데이트
    let curBobX = bobberX;
    let curBobY = bobberBaseY;
    let curBobZ = bobberZ;
    let lineSag = 0.42;

    if (phase === "casting") {
      if (phaseElapsed < CAST_RELEASE_TIME) {
        // 백스윙·초반 휘두름: 찌가 낚싯대 끝 바로 아래 매달려 함께 흔들림
        curBobX = tipX - dirX * 0.08;
        curBobY = tipY - 0.36;
        curBobZ = tipZ - dirZ * 0.08;
        lineSag = 0.03;
      } else {
        if (!releaseCaptured) {
          releaseCaptured = true;
          launchX = tipX;
          launchY = tipY;
          launchZ = tipZ;
        }
        const flightT = Math.min(1, (phaseElapsed - CAST_RELEASE_TIME) / (CAST_DURATION_SEC - CAST_RELEASE_TIME));
        const arcH = Math.sin(flightT * Math.PI) * 1.95;
        curBobX = launchX + (bobberX - launchX) * flightT;
        curBobY = launchY + (bobberBaseY - launchY) * flightT + arcH;
        curBobZ = launchZ + (bobberZ - launchZ) * flightT;
        lineSag = 0.14 + (1 - flightT) * 0.12;
      }
      bobberGroup.position.set(curBobX, curBobY, curBobZ);
      bobberGroup.rotation.set(phaseElapsed * 8.0, castPlayerYaw, 0);
      for (let i = 0; i < RIPPLE_COUNT; i += 1) {
        rippleMeshes[i]!.visible = false;
      }
    } else {
      const isBite = phase === "bite";
      const bobOffsetY = isBite
        ? -0.07 + Math.sin(elapsed * 26.0) * 0.13
        : Math.sin(elapsed * 3.2) * 0.042;
      const jitterX = isBite ? Math.sin(elapsed * 31.0) * 0.07 : 0;
      const jitterZ = isBite ? Math.cos(elapsed * 27.0) * 0.07 : 0;
      curBobX = bobberX + jitterX;
      curBobY = bobberBaseY + bobOffsetY;
      curBobZ = bobberZ + jitterZ;
      lineSag = isBite ? 0.07 : 0.42;

      bobberGroup.position.set(curBobX, curBobY, curBobZ);
      bobberGroup.rotation.set(
        isBite ? Math.sin(elapsed * 22) * 0.38 : Math.sin(elapsed * 2.3) * 0.08,
        elapsed * (isBite ? 4.5 : 0.7),
        isBite ? Math.cos(elapsed * 19) * 0.35 : Math.cos(elapsed * 1.9) * 0.08,
      );

      // 수면 파문 링 3개 (착수 직후 0.95s 3중 스플래시 / 대기 잔잔한 파문 / 입질 황금 물보라!)
      const isSplash = splashRippleTimer > 0;
      const rippleSpeed = isBite ? 1.95 : isSplash ? 1.55 : 0.65;
      for (let i = 0; i < RIPPLE_COUNT; i += 1) {
        const mesh = rippleMeshes[i]!;
        const mat = rippleMats[i]!;
        const rT = (elapsed * rippleSpeed + i / RIPPLE_COUNT) % 1;
        const maxScale = isBite ? 5.2 : isSplash ? 4.4 : 2.6;
        const scale = 0.72 + rT * maxScale;
        mesh.visible = true;
        mesh.position.set(curBobX, bobberBaseY + 0.04, curBobZ);
        mesh.scale.set(scale, 1, scale);
        mat.color.setHex(isBite ? 0xfde047 : isSplash ? 0xffffff : 0xe0f2fe);
        mat.opacity = (1 - rT) * (isBite ? 0.85 : isSplash ? 0.76 : 0.42);
      }
    }

    // 곡선 낚싯줄 정점 업데이트
    const midX = (tipX + curBobX) * 0.5;
    const midY = (tipY + curBobY) * 0.5 - lineSag;
    const midZ = (tipZ + curBobZ) * 0.5;
    for (let i = 0; i < LINE_POINTS; i += 1) {
      const t = i / (LINE_POINTS - 1);
      const inv = 1 - t;
      linePositions[i * 3] = inv * inv * tipX + 2 * inv * t * midX + t * t * curBobX;
      linePositions[i * 3 + 1] = inv * inv * tipY + 2 * inv * t * midY + t * t * (curBobY + 0.14);
      linePositions[i * 3 + 2] = inv * inv * tipZ + 2 * inv * t * midZ + t * t * curBobZ;
    }
    lineAttr.needsUpdate = true;

    return phase;
  }

  function syncCompanionAnglers(
    anglers: readonly CompanionAnglerPose[],
    elapsedSec: number,
  ): void {
    const count = Math.min(anglers.length, MAX_COMPANION_ANGLERS);
    if (count === 0) {
      if (companionRoot.visible) {
        companionRoot.visible = false;
        for (let i = 0; i < companionSlots.length; i += 1) {
          companionSlots[i]!.group.visible = false;
        }
      }
      return;
    }

    companionRoot.visible = true;
    for (let i = 0; i < companionSlots.length; i += 1) {
      const slot = companionSlots[i]!;
      if (i >= count) {
        slot.group.visible = false;
        continue;
      }
      const angler = anglers[i]!;
      slot.group.visible = true;

      const clampedX = Math.max(-BROOK_SPAN_HALF_X + 2, Math.min(BROOK_SPAN_HALF_X - 2, angler.x));
      const bp = brookProfile(clampedX);
      const sideOffset = (i - 1) * 0.55;
      const targetX = Math.max(-BROOK_SPAN_HALF_X + 2, Math.min(BROOK_SPAN_HALF_X - 2, clampedX + sideOffset));
      const targetZ = brookProfile(targetX).centerZ + (i % 2 === 0 ? -0.22 : 0.22) * Math.min(1, bp.halfWidth * 0.45);
      const aimYaw = Math.atan2(targetX - angler.x, targetZ - angler.z);

      const dirX = Math.sin(aimYaw);
      const dirZ = Math.cos(aimYaw);
      const rightX = Math.cos(aimYaw);
      const rightZ = -Math.sin(aimYaw);

      const handX = angler.x + rightX * 0.36 + dirX * 0.18;
      const handY = 0.68;
      const handZ = angler.z + rightZ * 0.36 + dirZ * 0.18;
      const phaseSeed = i * 1.93 + 0.5;
      const rodPitch = 0.72 + Math.sin(elapsedSec * 1.85 + phaseSeed) * 0.045;

      slot.rodGroup.position.set(handX, handY, handZ);
      slot.rodGroup.rotation.set(0, aimYaw, 0);
      slot.rodGroup.rotateX(rodPitch);
      slot.rodGroup.updateMatrixWorld(true);
      slot.tipMesh.getWorldPosition(tipWorldScratch);

      const tipX = tipWorldScratch.x;
      const tipY = tipWorldScratch.y;
      const tipZ = tipWorldScratch.z;

      const bobY = -0.06 + Math.sin(elapsedSec * 2.9 + phaseSeed) * 0.036;
      slot.bobberGroup.position.set(targetX, bobY, targetZ);
      slot.bobberGroup.rotation.set(
        Math.sin(elapsedSec * 2.1 + phaseSeed) * 0.09,
        elapsedSec * 0.6 + phaseSeed,
        Math.cos(elapsedSec * 1.7 + phaseSeed) * 0.08,
      );

      const midX = (tipX + targetX) * 0.5;
      const midY = (tipY + bobY) * 0.5 - 0.30;
      const midZ = (tipZ + targetZ) * 0.5;
      for (let p = 0; p < COMPANION_LINE_POINTS; p += 1) {
        const t = p / (COMPANION_LINE_POINTS - 1);
        const inv = 1 - t;
        slot.linePositions[p * 3] = inv * inv * tipX + 2 * inv * t * midX + t * t * targetX;
        slot.linePositions[p * 3 + 1] = inv * inv * tipY + 2 * inv * t * midY + t * t * (bobY + 0.11);
        slot.linePositions[p * 3 + 2] = inv * inv * tipZ + 2 * inv * t * midZ + t * t * targetZ;
      }
      slot.lineAttr.needsUpdate = true;

      const rT = (elapsedSec * 0.58 + i * 0.33) % 1;
      const rScale = 0.55 + rT * 1.95;
      slot.rippleMesh.position.set(targetX, -0.02, targetZ);
      slot.rippleMesh.scale.set(rScale, 1, rScale);
      slot.rippleMat.opacity = (1 - rT) * 0.38;
    }
  }

  function dispose(): void {
    miniRodGeo.dispose();
    for (let i = 0; i < companionSlots.length; i += 1) {
      const slot = companionSlots[i]!;
      slot.lineGeo.dispose();
      slot.rippleMat.dispose();
    }
    scene.remove(companionRoot);
    rodGripGeo.dispose();
    rodGripMat.dispose();
    rodSeg1Geo.dispose();
    rodSeg2Geo.dispose();
    rodSeg3Geo.dispose();
    rodSegMat.dispose();
    rodBandGeo.dispose();
    rodBandMat.dispose();
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
    fishBodyGeo.dispose();
    fishBodyMat.dispose();
    fishFinGeo.dispose();
    fishFinMat.dispose();
    fishEyeGeo.dispose();
    fishEyeMat.dispose();
    bottleBodyGeo.dispose();
    bottleNeckGeo.dispose();
    bottleGlassMat.dispose();
    bottleCorkGeo.dispose();
    bottleCorkMat.dispose();
    scrollGeo.dispose();
    scrollMat.dispose();
    jellyBellGeo.dispose();
    jellyBellMat.dispose();
    jellyCoreGeo.dispose();
    jellyCoreMat.dispose();
    tentacleGeo.dispose();
    tentacleMat.dispose();
    shellValveGeo.dispose();
    shellValveMat.dispose();
    pearlGeo.dispose();
    pearlMat.dispose();
    scene.remove(root);
  }

  return {
    isNearWater,
    startCast,
    reelIn,
    cancel,
    getPhase: () => phase,
    getUiPhase,
    getCastTargetYaw: () => castPlayerYaw,
    getCastProgress,
    syncCompanionAnglers,
    update,
    dispose,
  };
}
