import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
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
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";

import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import type { WorldZoneSpec } from "../../shared/world-types.js";

/**
 * 넓게 펼쳐진 초원 마을(Meadow Village) 3D 지형 · 시냇물/연못 · 하프팀버 건축물 · 고디테일 공방 오브젝트 ·
 * 바람에 흔들리는 인스탄싱 풀잎/들꽃/반딧불이 및 원형 장애물 충돌 시스템.
 */

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

const BROOK_VERTEX = /* glsl */ `
uniform float uTime;
out vec3 vWorldPos;
out vec3 vWaveNorm;

void main() {
  vec3 lp = position;
  float w1 = sin(lp.x * 0.75 + uTime * 2.4) * cos(lp.z * 0.68 + uTime * 1.9) * 0.028;
  float w2 = sin((lp.x * 1.3 - lp.z * 0.9) - uTime * 3.1) * 0.015;
  lp.y += w1 + w2;
  vWaveNorm = normalize(vec3(
    -0.04 * cos(lp.x * 0.75 + uTime * 2.4),
    1.0,
    -0.04 * sin(lp.z * 0.68 + uTime * 1.9)
  ));
  vec4 wp = modelMatrix * vec4(lp, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BROOK_FRAGMENT = /* glsl */ `
in vec3 vWorldPos;
in vec3 vWaveNorm;
out vec4 fragColor;

uniform float uTime;
uniform float uNight;
uniform vec3 uSunDir;

void main() {
  vec3 N = normalize(vWaveNorm);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDir);

  vec3 dayShallow = vec3(0.20, 0.68, 0.86);
  vec3 dayDeep = vec3(0.11, 0.48, 0.74);
  vec3 nightWater = vec3(0.06, 0.16, 0.32);

  float flow = sin(vWorldPos.x * 1.4 - uTime * 2.8 + sin(vWorldPos.z * 1.2) * 1.5) * 0.5 + 0.5;
  vec3 baseCol = mix(mix(dayDeep, dayShallow, flow * 0.55), nightWater, uNight);

  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.6) * 0.42;
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 84.0) * (1.0 - uNight * 0.5) * 0.95;

  vec3 col = mix(baseCol, mix(vec3(0.68, 0.91, 1.0), vec3(0.22, 0.36, 0.58), uNight), fres);
  col += vec3(1.0, 0.97, 0.86) * spec;
  col += vec3(0.88, 0.97, 1.0) * smoothstep(0.82, 0.98, flow) * 0.18 * (1.0 - uNight * 0.6);

  fragColor = vec4(col, 0.90);
}
`;

export interface CircleCollider {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

export interface MeadowSceneHandle {
  readonly group: Group;
  readonly streetlampAnchors: readonly Vector3[];
  syncZones(zones: readonly WorldZoneSpec[]): void;
  getGroundHeight(x: number, z: number): number;
  isWalkable(x: number, z: number): boolean;
  resolveMovement(curX: number, curZ: number, nextX: number, nextZ: number, actorRadius?: number): { x: number; z: number };
  update(elapsed: number, nightFactor: number, sunDir: Vector3): void;
  dispose(): void;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** 남동쪽 초원을 가로지르는 시냇물 중심선 Z 및 폭 계산 */
function brookProfile(x: number): { centerZ: number; halfWidth: number } {
  const centerZ = 9.2 + Math.sin(x * 0.095) * 2.9 + Math.cos(x * 0.04) * 1.1;
  // (6.0, centerZ) 부근에서 연못처럼 넓어짐
  const pondBell = Math.exp(-Math.pow((x - 5.8) / 4.8, 2));
  const halfWidth = 1.45 + pondBell * 2.15;
  return { centerZ, halfWidth };
}

export function createMeadowScene(scene: Scene): MeadowSceneHandle {
  const root = new Group();
  const dynamicWorldGroup = new Group();
  root.add(dynamicWorldGroup);

  // 공통 PBR 머티리얼 팔레트
  const matPlaster = new MeshStandardMaterial({ color: 0xf7efe1, roughness: 0.84 });
  const matPlasterWarm = new MeshStandardMaterial({ color: 0xf2e4cc, roughness: 0.86 });
  const matTimber = new MeshStandardMaterial({ color: 0x5c3a24, roughness: 0.88 });
  const matWood = new MeshStandardMaterial({ color: 0x8f5b38, roughness: 0.84 });
  const matWoodLight = new MeshStandardMaterial({ color: 0xc89d6c, roughness: 0.82 });
  const matStone = new MeshStandardMaterial({ color: 0xb7c2cf, roughness: 0.86 });
  const matStoneDark = new MeshStandardMaterial({ color: 0x8492a2, roughness: 0.88 });
  const matIron = new MeshStandardMaterial({ color: 0x2f3b4c, roughness: 0.5, metalness: 0.42 });
  const matBrass = new MeshStandardMaterial({ color: 0xeab308, roughness: 0.36, metalness: 0.62 });
  const matCanvas = new MeshStandardMaterial({ color: 0xfcf8ee, roughness: 0.78, side: DoubleSide });
  const matParchment = new MeshStandardMaterial({ color: 0xf3e5c0, roughness: 0.88 });

  const matLeafBright = new MeshStandardMaterial({ color: 0x58c45a, roughness: 0.86 });
  const matLeafRich = new MeshStandardMaterial({ color: 0x41a64c, roughness: 0.88 });
  const matLeafPine = new MeshStandardMaterial({ color: 0x2f8548, roughness: 0.88 });
  const matLeafBlossom = new MeshStandardMaterial({ color: 0xf9a8c9, roughness: 0.84 });
  const matBush = new MeshStandardMaterial({ color: 0x4db556, roughness: 0.86 });

  const matWindow = new MeshStandardMaterial({
    color: 0xfff3ba,
    emissive: 0xffb830,
    emissiveIntensity: 0.14,
    roughness: 0.35,
  });
  const matLanternGlass = new MeshStandardMaterial({
    color: 0xfff5c0,
    emissive: 0xffc43d,
    emissiveIntensity: 0.22,
    roughness: 0.28,
  });
  const matScreen = new MeshStandardMaterial({
    color: 0x67e8f9,
    emissive: 0x22d3ee,
    emissiveIntensity: 0.65,
    roughness: 0.28,
  });
  const matFlameOuter = new MeshStandardMaterial({
    color: 0xff7b1c,
    emissive: 0xff5a00,
    emissiveIntensity: 1.5,
    roughness: 0.3,
  });
  const matFlameCore = new MeshStandardMaterial({
    color: 0xfff078,
    emissive: 0xffd026,
    emissiveIntensity: 1.9,
    roughness: 0.2,
  });

  // 1. 초원 지형 메쉬 (220m x 220m 연속 지형 + 정점 컬러 포장도로/언덕/원경 산맥)
  const TERRAIN_SIZE = 220;
  const TERRAIN_SEG = 148;
  const terrainGeo = new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEG, TERRAIN_SEG);
  terrainGeo.rotateX(-Math.PI * 0.5);
  const terrainColorAttr = new BufferAttribute(new Float32Array((TERRAIN_SEG + 1) * (TERRAIN_SEG + 1) * 3), 3);
  terrainGeo.setAttribute("color", terrainColorAttr);
  const terrainMat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.01,
  });
  const terrainMesh = new Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  root.add(terrainMesh);

  // 2. 시냇물 & 연못 수면 메쉬 (지형이 파인 시냇물 바닥에만 노출됨)
  const brookGeo = new PlaneGeometry(110, 32, 88, 28);
  brookGeo.rotateX(-Math.PI * 0.5);
  const brookMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 0 },
      uSunDir: { value: new Vector3(0.5, 0.85, 0.4) },
    },
    vertexShader: BROOK_VERTEX,
    fragmentShader: BROOK_FRAGMENT,
  });
  const brookMesh = new Mesh(brookGeo, brookMat);
  brookMesh.position.set(0, -0.09, 9.5);
  root.add(brookMesh);

  // 3. 상공 뭉게구름 링 (넓은 초원 상공에 여유롭게 배치)
  const cloudGroup = new Group();
  const matCloud = new MeshStandardMaterial({ color: 0xfafcff, roughness: 0.96 });
  const cloudSeeds: readonly [number, number, number, number][] = [
    [-28, 18.5, -34, 1.3],
    [18, 20.0, -38, 1.45],
    [38, 17.5, -8, 1.2],
    [-36, 18.0, 14, 1.25],
    [14, 19.5, 36, 1.35],
    [-16, 21.0, 38, 1.15],
  ];
  cloudSeeds.forEach(([cx, cy, cz, sc]) => {
    const cg = new Group();
    cg.position.set(cx, cy, cz);
    cg.scale.setScalar(sc);
    const puffs: readonly [number, number, number, number, number, number][] = [
      [0, 0, 0, 2.6, 0.95, 1.65],
      [1.7, -0.18, 0.16, 1.8, 0.78, 1.35],
      [-1.65, -0.2, -0.14, 1.7, 0.74, 1.25],
      [0.45, 0.42, -0.1, 1.45, 0.72, 1.2],
    ];
    puffs.forEach(([px, py, pz, sx, sy, sz]) => {
      const m = new Mesh(new SphereGeometry(1, 12, 10), matCloud);
      m.position.set(px, py, pz);
      m.scale.set(sx, sy, sz);
      cg.add(m);
    });
    cloudGroup.add(cg);
  });
  root.add(cloudGroup);

  // 4. 풍차 날개 그룹 (4엽 캔버스 격자 날개)
  const windmillBlades = new Group();
  const rotorHub = new Mesh(new CylinderGeometry(0.22, 0.26, 0.42, 12), matBrass);
  rotorHub.rotation.x = Math.PI * 0.5;
  windmillBlades.add(rotorHub);
  for (let i = 0; i < 4; i += 1) {
    const armGroup = new Group();
    armGroup.rotation.z = (i * Math.PI) / 2;
    const spar = new Mesh(new BoxGeometry(0.11, 2.35, 0.09), matTimber);
    spar.position.y = 1.22;
    spar.castShadow = true;
    const sail = new Mesh(new BoxGeometry(0.56, 1.78, 0.03), matCanvas);
    sail.position.set(0.26, 1.38, 0.02);
    sail.castShadow = true;
    const rib1 = new Mesh(new BoxGeometry(0.58, 0.045, 0.05), matWood);
    rib1.position.set(0.26, 0.85, 0.02);
    const rib2 = new Mesh(new BoxGeometry(0.58, 0.045, 0.05), matWood);
    rib2.position.set(0.26, 1.38, 0.02);
    const rib3 = new Mesh(new BoxGeometry(0.58, 0.045, 0.05), matWood);
    rib3.position.set(0.26, 1.92, 0.02);
    armGroup.add(spar, sail, rib1, rib2, rib3);
    windmillBlades.add(armGroup);
  }

  // 모닥불 다층 불꽃 & 굴뚝 연기 파티클
  const flameGroup = new Group();
  const flameOuter = new Mesh(new ConeGeometry(0.32, 0.72, 9), matFlameOuter);
  flameOuter.position.y = 0.34;
  const flameCore = new Mesh(new ConeGeometry(0.19, 0.50, 8), matFlameCore);
  flameCore.position.y = 0.25;
  flameGroup.add(flameOuter, flameCore);

  const smokePuffs: { mesh: Mesh; phase: number; baseX: number; baseY: number; baseZ: number }[] = [];
  const matSmoke = new MeshStandardMaterial({ color: 0xeef2f6, roughness: 0.95, transparent: true, opacity: 0.52 });

  // 캠프 깃발 애니메이션 목록
  const bannerMeshes: { mesh: Mesh; baseRotY: number; phase: number }[] = [];

  // 5. GPU 바람 스웨이 인스탄싱 풀잎(2,800개 — 상향 법선 3엽 풀포기) & 줄기 들꽃(520개) & 야간 반딧불이(56개)
  const MAX_GRASS = 2800;
  const MAX_FLOWERS = 520;
  const MAX_FIREFLIES = 56;
  const windTimeUniform = { value: 0 };

  function createGrassTuftGeometry(): BufferGeometry {
    // 3장의 가늘고 부드러운 풀잎 리본이 부채꼴로 퍼진 한 포기 지오메트리.
    // 법선을 (0, 1, 0) 상향으로 고정해 지면 잔디와 동일한 조명을 받아 주간 음영 줄무늬와 야간 검은 삼각형을 없앤다!
    const positions: number[] = [];
    const normals: number[] = [];
    const blades: readonly [number, number, number, number][] = [
      [-0.08, 0.30, -0.05, 0.036],
      [0.01, 0.36, 0.02, 0.038],
      [0.09, 0.28, -0.04, 0.034],
    ];
    for (const [tipX, tipY, tipZ, halfW] of blades) {
      const baseX = tipX * 0.22;
      const baseZ = tipZ * 0.22;
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
    roughness: 0.90,
    metalness: 0.0,
    side: DoubleSide,
  });
  grassMat.onBeforeCompile = (shader) => {
    shader.uniforms["uWindTime"] = windTimeUniform;
    shader.vertexShader = `uniform float uWindTime;\n` + shader.vertexShader.replace(
      "#include <begin_vertex>",
      /* glsl */ `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float sway = sin(uWindTime * 2.2 + instPos.x * 0.38 + instPos.z * 0.29) * 0.12
                   + cos(uWindTime * 3.4 + instPos.x * 0.7) * 0.04;
        float bend = clamp(position.y / 0.36, 0.0, 1.0);
        transformed.x += sway * bend * bend;
        transformed.z += sway * 0.55 * bend * bend;
      #endif
      `,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_begin>",
      /* glsl */ `
      #include <normal_fragment_begin>
      normal = normalize(vNormal);
      `,
    );
  };
  const grassInstanced = new InstancedMesh(grassBladeGeo, grassMat, MAX_GRASS);
  grassInstanced.receiveShadow = true;
  grassInstanced.frustumCulled = false;
  root.add(grassInstanced);

  function createWildflowerGeometry(): BufferGeometry {
    // 초록 줄기(partTag=0) + 5장 꽃잎(partTag=1) + 노란 꽃술 중심(partTag=2)을 단일 메쉬에 담고 상향 법선 부여
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
    // 십자 교차 가느다란 줄기 (y = 0 .. 0.23)
    const sw = 0.016;
    pushTri(-sw, 0, 0, sw, 0, 0, 0, 0.24, 0, 0);
    pushTri(0, 0, -sw, 0, 0, sw, 0, 0.24, 0, 0);

    // 5장 방사형 꽃잎 (y = 0.24)
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
    // 중앙 꽃술 (y = 0.254)
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
    const rad = 4 + (i % 11) * 3.1;
    return {
      x: Math.cos(ang) * rad,
      z: Math.sin(ang) * rad,
      phase: i * 1.37,
    };
  });

  // 다리(시냇물 횡단 아치교) 좌표: 광장(0,0) → 사령관 정원 언덕(14.5, 14.5) 연결선 위
  const BRIDGE_X = 7.8;
  const BRIDGE_BROOK = brookProfile(BRIDGE_X);
  const BRIDGE_Z = BRIDGE_BROOK.centerZ;
  const BRIDGE_YAW = 0.56; // 북서↔남동 대각선 방향

  let currentSignature = "";
  let currentZones: readonly WorldZoneSpec[] = [];
  let roadSegments: { ax: number; az: number; bx: number; bz: number; width: number }[] = [];
  let colliders: CircleCollider[] = [];
  const streetlampAnchors: Vector3[] = [];

  /** 도로까지 최단 거리 계산 (포장도로 정점 컬러 & 풀잎 제외 마스크용) */
  function minRoadDistance(x: number, z: number): { dist: number; halfWidth: number } {
    // 중앙 광장 원형 돌바닥
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
      // 자연스러운 오솔길 곡률 보정
      const perpX = -vz / Math.sqrt(len2);
      const perpZ = vx / Math.sqrt(len2);
      const curve = Math.sin(t * Math.PI) * 0.85;
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

  /** 시냇물 다리 위 판정 */
  function getBridgeDeckHeight(x: number, z: number): number | null {
    const dx = x - BRIDGE_X;
    const dz = z - BRIDGE_Z;
    const c = Math.cos(-BRIDGE_YAW);
    const s = Math.sin(-BRIDGE_YAW);
    const localX = dx * c - dz * s;
    const localZ = dx * s + dz * c;
    const halfSpan = BRIDGE_BROOK.halfWidth + 1.55;
    if (Math.abs(localX) <= 1.32 && Math.abs(localZ) <= halfSpan) {
      const arch = Math.cos((localZ / halfSpan) * Math.PI * 0.5);
      return 0.34 + arch * 0.44;
    }
    return null;
  }

  /** 연속 초원 지형 높이 계산 (다리 포함) */
  function getTerrainBaseHeight(x: number, z: number): number {
    const rCenter = Math.hypot(x, z);

    // 기본 초원 구릉 기복
    let h = 0.34
      + Math.sin(x * 0.065) * Math.cos(z * 0.062) * 0.52
      + Math.sin((x + z) * 0.11) * 0.18
      + Math.cos((x - z * 1.2) * 0.045) * 0.28;

    // 원경 목초지 언덕 & 산맥 실루엣 (r > 44m 부터 부드럽게 솟아오름)
    if (rCenter > 42) {
      const rimT = smoothstep(42, 98, rCenter);
      const ridge = 1.0 + 0.48 * Math.sin(Math.atan2(z, x) * 5.0 + 0.7) + 0.28 * Math.cos(Math.atan2(z, x) * 9.0);
      h += rimT * rimT * 16.5 * ridge;
    }

    // 각 마을 구역(광장·캠프·정원) 평탄화 테라스 블렌딩
    for (const zone of currentZones) {
      const d = Math.hypot(x - zone.x, z - zone.z);
      const flatR = zone.kind === "plaza" ? 10.5 : 6.4;
      if (d < flatR + 5.5) {
        const w = 1 - smoothstep(flatR - 1.2, flatR + 5.5, d);
        const targetH = zone.kind === "plaza" ? 0.36 : zone.kind === "garden" ? 0.58 : 0.44;
        h = h * (1 - w) + targetH * w;
      }
    }

    // 남동쪽 시냇물 & 연못 수로 조각 (x 범위 -46..46 내)
    if (Math.abs(x) < 48) {
      const { centerZ, halfWidth } = brookProfile(x);
      const bd = Math.abs(z - centerZ);
      if (bd < halfWidth + 2.2) {
        const bankFactor = 1 - smoothstep(halfWidth * 0.55, halfWidth + 2.0, bd);
        const edgeFade = 1 - smoothstep(38, 47, Math.abs(x));
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
    if (Math.hypot(x, z) > 44.5) return false;
    if (isWaterBlocked(x, z)) return false;
    for (const col of colliders) {
      if (Math.hypot(x - col.x, z - col.z) < col.r) return false;
    }
    return true;
  }

  function resolveMovement(curX: number, curZ: number, nextX: number, nextZ: number, actorRadius = 0.45): { x: number; z: number } {
    let rx = nextX;
    let rz = nextZ;

    // 1. 외곽 목장 경계 (반경 44m 부드러운 원형 클램프)
    const distFromOrigin = Math.hypot(rx, rz);
    if (distFromOrigin > 44.0) {
      rx = (rx / distFromOrigin) * 44.0;
      rz = (rz / distFromOrigin) * 44.0;
    }

    // 2. 건물·나무·연못·우물·모닥불 원형 슬라이딩 충돌 해소
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

    // 3. 시냇물 침수 방지 (다리 위는 통과, 물가에서는 강변을 따라 슬라이딩)
    if (isWaterBlocked(rx, rz)) {
      if (!isWaterBlocked(rx, curZ)) {
        rz = curZ;
      } else if (!isWaterBlocked(curX, rz)) {
        rx = curX;
      } else {
        rx = curX;
        rz = curZ;
      }
    }

    return { x: rx, z: rz };
  }

  // ─── 고디테일 오브젝트 빌더 함수들 ──────────────────────────────────────────────

  function addTree(parent: Group, tx: number, tz: number, scale: number, kind: "oak" | "pine" | "blossom") {
    const gy = getTerrainBaseHeight(tx, tz);
    if (gy < 0.08) return;
    const tg = new Group();
    tg.position.set(tx, gy, tz);

    if (kind === "pine") {
      const trunk = new Mesh(new CylinderGeometry(0.14 * scale, 0.24 * scale, 1.3 * scale, 8), matTimber);
      trunk.position.y = 0.62 * scale;
      trunk.castShadow = true;
      trunk.receiveShadow = true;
      tg.add(trunk);

      const tiers: readonly [number, number, number][] = [
        [1.15, 1.45, 1.45],
        [0.92, 1.30, 2.25],
        [0.64, 1.12, 2.95],
      ];
      tiers.forEach(([rad, h, py]) => {
        const cone = new Mesh(new ConeGeometry(rad * scale, h * scale, 10), matLeafPine);
        cone.position.y = py * scale;
        cone.castShadow = true;
        cone.receiveShadow = true;
        tg.add(cone);
      });
    } else {
      const trunk = new Mesh(new CylinderGeometry(0.17 * scale, 0.28 * scale, 1.45 * scale, 9), matTimber);
      trunk.position.y = 0.70 * scale;
      trunk.castShadow = true;
      trunk.receiveShadow = true;

      const branch = new Mesh(new CylinderGeometry(0.07 * scale, 0.11 * scale, 0.65 * scale, 7), matTimber);
      branch.position.set(0.24 * scale, 1.18 * scale, 0.08 * scale);
      branch.rotation.z = -0.68;
      tg.add(trunk, branch);

      const leafMat = kind === "blossom" ? matLeafBlossom : (Math.abs(Math.round(tx + tz)) % 2 === 0 ? matLeafBright : matLeafRich);
      const puffs: readonly [number, number, number, number][] = [
        [0, 1.88, 0, 0.98],
        [0.52, 1.56, 0.28, 0.68],
        [-0.48, 1.58, -0.24, 0.66],
        [0.14, 1.62, -0.48, 0.62],
        [-0.22, 1.54, 0.44, 0.58],
      ];
      puffs.forEach(([px, py, pz, r]) => {
        const sp = new Mesh(new SphereGeometry(r * scale, 12, 10), leafMat);
        sp.position.set(px * scale, py * scale, pz * scale);
        sp.scale.set(1.04, 0.88, 1.04);
        sp.castShadow = true;
        sp.receiveShadow = true;
        tg.add(sp);
      });
    }

    parent.add(tg);
    colliders.push({ x: tx, z: tz, r: 0.42 * scale });
  }

  function addBushAndRockCluster(parent: Group, bx: number, bz: number, scale = 1.0) {
    const gy = getTerrainBaseHeight(bx, bz);
    if (gy < 0.05) return;
    const g = new Group();
    g.position.set(bx, gy, bz);

    const b1 = new Mesh(new SphereGeometry(0.42 * scale, 9, 8), matBush);
    b1.position.set(0, 0.26 * scale, 0);
    b1.scale.set(1.15, 0.78, 1.05);
    b1.castShadow = true;
    const b2 = new Mesh(new SphereGeometry(0.30 * scale, 8, 7), matLeafBright);
    b2.position.set(0.32 * scale, 0.20 * scale, 0.14 * scale);
    b2.castShadow = true;

    const rock = new Mesh(new SphereGeometry(0.28 * scale, 7, 6), matStone);
    rock.position.set(-0.34 * scale, 0.14 * scale, 0.18 * scale);
    rock.scale.set(1.25, 0.72, 0.95);
    rock.rotation.y = 0.8;
    rock.castShadow = true;
    rock.receiveShadow = true;

    g.add(b1, b2, rock);
    parent.add(g);
  }

  function addFenceRun(parent: Group, ax: number, az: number, bx: number, bz: number, posts: number) {
    const yaw = Math.atan2(bx - ax, bz - az);
    const totalLen = Math.hypot(bx - ax, bz - az);
    const segLen = totalLen / Math.max(1, posts - 1);

    for (let i = 0; i < posts; i += 1) {
      const t = posts === 1 ? 0 : i / (posts - 1);
      const px = ax + (bx - ax) * t;
      const pz = az + (bz - az) * t;
      const py = getTerrainBaseHeight(px, pz);
      if (py < 0.05) continue;

      const post = new Mesh(new BoxGeometry(0.12, 0.78, 0.12), matWood);
      post.position.set(px, py + 0.36, pz);
      post.rotation.y = yaw;
      post.castShadow = true;
      parent.add(post);

      if (i < posts - 1) {
        const mx = ax + (bx - ax) * ((i + 0.5) / (posts - 1));
        const mz = az + (bz - az) * ((i + 0.5) / (posts - 1));
        const my = getTerrainBaseHeight(mx, mz);
        for (const ry of [0.28, 0.54]) {
          const rail = new Mesh(new BoxGeometry(0.07, 0.08, segLen + 0.06), matWoodLight);
          rail.position.set(mx, my + ry, mz);
          rail.rotation.y = yaw;
          rail.castShadow = true;
          parent.add(rail);
        }
      }
    }
  }

  /** 곡선 주철 가로등 + 매달린 육각 유리 랜턴 */
  function addHangingStreetlamp(parent: Group, lx: number, lz: number, armYaw = 0) {
    const gy = getTerrainBaseHeight(lx, lz);
    if (gy < 0.05) return;
    const g = new Group();
    g.position.set(lx, gy, lz);
    g.rotation.y = armYaw;

    const plinth = new Mesh(new CylinderGeometry(0.15, 0.20, 0.24, 8), matIron);
    plinth.position.y = 0.12;
    const pole = new Mesh(new CylinderGeometry(0.055, 0.085, 2.25, 8), matIron);
    pole.position.y = 1.24;
    pole.castShadow = true;

    const arm = new Mesh(new BoxGeometry(0.06, 0.06, 0.58), matIron);
    arm.position.set(0, 2.34, 0.24);
    arm.rotation.x = -0.14;

    const brace = new Mesh(new BoxGeometry(0.045, 0.36, 0.045), matIron);
    brace.position.set(0, 2.15, 0.14);
    brace.rotation.x = 0.65;

    const lanternCap = new Mesh(new ConeGeometry(0.19, 0.16, 6), matIron);
    lanternCap.position.set(0, 2.24, 0.48);
    const lanternGlass = new Mesh(new CylinderGeometry(0.13, 0.10, 0.24, 6), matLanternGlass);
    lanternGlass.position.set(0, 2.08, 0.48);
    const lanternBase = new Mesh(new CylinderGeometry(0.11, 0.06, 0.06, 6), matIron);
    lanternBase.position.set(0, 1.94, 0.48);

    g.add(plinth, pole, arm, brace, lanternCap, lanternGlass, lanternBase);
    parent.add(g);

    const worldBulbX = lx + Math.sin(armYaw) * 0.48;
    const worldBulbZ = lz + Math.cos(armYaw) * 0.48;
    streetlampAnchors.push(new Vector3(worldBulbX, gy + 0.18, worldBulbZ));
  }

  /** 다리가 제대로 달린 통나무 벤치 */
  function addWoodenBench(parent: Group, bx: number, bz: number, yaw: number) {
    const gy = getTerrainBaseHeight(bx, bz);
    const g = new Group();
    g.position.set(bx, gy, bz);
    g.rotation.y = yaw;

    const seat = new Mesh(new BoxGeometry(1.38, 0.09, 0.42), matWoodLight);
    seat.position.y = 0.34;
    seat.castShadow = true;
    seat.receiveShadow = true;

    const back = new Mesh(new BoxGeometry(1.34, 0.24, 0.07), matWoodLight);
    back.position.set(0, 0.54, -0.18);
    back.rotation.x = -0.14;
    back.castShadow = true;

    for (const lx of [-0.52, 0.52]) {
      const legF = new Mesh(new BoxGeometry(0.10, 0.34, 0.10), matTimber);
      legF.position.set(lx, 0.17, 0.13);
      const legB = new Mesh(new BoxGeometry(0.10, 0.58, 0.10), matTimber);
      legB.position.set(lx, 0.29, -0.15);
      g.add(legF, legB);
    }

    g.add(seat, back);
    parent.add(g);
  }

  /** 틀·덧창·꽃화분이 갖춰진 창문 조립체 */
  function createFramedWindow(withFlowerBox = true): Group {
    const wg = new Group();
    const frame = new Mesh(new BoxGeometry(0.68, 0.72, 0.08), matTimber);
    const glass = new Mesh(new BoxGeometry(0.54, 0.58, 0.09), matWindow);
    const mullionV = new Mesh(new BoxGeometry(0.045, 0.58, 0.11), matTimber);
    const mullionH = new Mesh(new BoxGeometry(0.54, 0.045, 0.11), matTimber);
    wg.add(frame, glass, mullionV, mullionH);

    if (withFlowerBox) {
      const box = new Mesh(new BoxGeometry(0.72, 0.14, 0.18), matWood);
      box.position.set(0, -0.40, 0.08);
      wg.add(box);
      const flowerColors = [0xf43f5e, 0xfacc15, 0xf9a8d4];
      flowerColors.forEach((hex, idx) => {
        const fl = new Mesh(
          new SphereGeometry(0.075, 6, 6),
          new MeshStandardMaterial({ color: hex, roughness: 0.7 }),
        );
        fl.position.set((idx - 1) * 0.20, -0.30, 0.10);
        wg.add(fl);
      });
    }
    return wg;
  }

  /** 박공지붕(Gable Roof) 조립체 — 처마 오버행 + 용마루 보 + 수직 삼각 박공벽(우물 등 개방형은 생략 가능) */
  function createPitchedRoof(width: number, height: number, depth: number, roofHex: number, includeGableWall = true): Group {
    const rg = new Group();
    const roofMat = new MeshStandardMaterial({ color: roofHex, roughness: 0.76 });
    const slopeLen = Math.hypot(width * 0.5 + 0.28, height);
    const slopeAngle = Math.atan2(height, width * 0.5 + 0.28);

    const leftPane = new Mesh(new BoxGeometry(slopeLen, 0.11, depth + 0.44), roofMat);
    leftPane.position.set(-(width * 0.25 + 0.10), height * 0.48, 0);
    leftPane.rotation.z = slopeAngle;
    leftPane.castShadow = true;
    leftPane.receiveShadow = true;

    const rightPane = new Mesh(new BoxGeometry(slopeLen, 0.11, depth + 0.44), roofMat);
    rightPane.position.set(width * 0.25 + 0.10, height * 0.48, 0);
    rightPane.rotation.z = -slopeAngle;
    rightPane.castShadow = true;
    rightPane.receiveShadow = true;

    const ridge = new Mesh(new BoxGeometry(0.16, 0.14, depth + 0.50), matTimber);
    ridge.position.set(0, height - 0.02, 0);
    ridge.castShadow = true;

    if (includeGableWall) {
      const hw = width * 0.495;
      const hd = depth * 0.495;
      const gh = height * 0.94;
      const verts = new Float32Array([
        // 전면 삼각형 (+Z)
        -hw, 0, hd,  hw, 0, hd,  0, gh, hd,
        // 후면 삼각형 (-Z)
         hw, 0, -hd, -hw, 0, -hd, 0, gh, -hd,
      ]);
      const gGeo = new BufferGeometry();
      gGeo.setAttribute("position", new BufferAttribute(verts, 3));
      gGeo.computeVertexNormals();
      const gableWall = new Mesh(gGeo, matPlaster);
      gableWall.castShadow = true;
      gableWall.receiveShadow = true;
      // 전면/후면 중앙 수직 목재 동바리(King Post) 트림
      const kingF = new Mesh(new BoxGeometry(0.11, gh * 0.96, 0.08), matTimber);
      kingF.position.set(0, gh * 0.48, hd + 0.02);
      const kingB = new Mesh(new BoxGeometry(0.11, gh * 0.96, 0.08), matTimber);
      kingB.position.set(0, gh * 0.48, -hd - 0.02);
      rg.add(gableWall, kingF, kingB);
    }

    rg.add(leftPane, rightPane, ridge);
    return rg;
  }

  /** 본부 길드 회관 & 풍차 시계탑 */
  function buildGrandGuildHall(parent: Group) {
    const hx = 0;
    const hz = -7.2;
    const gy = getTerrainBaseHeight(hx, hz);
    const hall = new Group();
    hall.position.set(hx, gy, hz);

    // 석조 기단 + 전면 나무 계단
    const plinth = new Mesh(new BoxGeometry(5.4, 0.36, 3.8), matStone);
    plinth.position.y = 0.18;
    plinth.receiveShadow = true;
    plinth.castShadow = true;
    const step1 = new Mesh(new BoxGeometry(1.75, 0.18, 0.55), matStoneDark);
    step1.position.set(0, 0.09, 2.12);
    step1.receiveShadow = true;

    // 본관 회벽 + 하프팀버 목재 골조
    const walls = new Mesh(new BoxGeometry(4.8, 2.45, 3.3), matPlaster);
    walls.position.y = 1.58;
    walls.castShadow = true;
    walls.receiveShadow = true;
    hall.add(plinth, step1, walls);

    for (const cx of [-2.38, -0.82, 0.82, 2.38]) {
      for (const cz of [-1.64, 1.64]) {
        const post = new Mesh(new BoxGeometry(0.13, 2.48, 0.13), matTimber);
        post.position.set(cx, 1.58, cz);
        hall.add(post);
      }
    }
    for (const by of [0.42, 1.55, 2.76]) {
      const beamF = new Mesh(new BoxGeometry(4.92, 0.11, 0.10), matTimber);
      beamF.position.set(0, by, 1.65);
      const beamB = new Mesh(new BoxGeometry(4.92, 0.11, 0.10), matTimber);
      beamB.position.set(0, by, -1.65);
      hall.add(beamF, beamB);
    }

    // 아치형 오크 정문 + 현관 캐노피 포치
    const doorFrame = new Mesh(new BoxGeometry(1.16, 1.58, 0.12), matTimber);
    doorFrame.position.set(0, 1.15, 1.66);
    const doorLeaf = new Mesh(new BoxGeometry(0.96, 1.44, 0.14), matWood);
    doorLeaf.position.set(0, 1.12, 1.67);
    const handleL = new Mesh(new SphereGeometry(0.045, 7, 7), matBrass);
    handleL.position.set(-0.10, 1.08, 1.76);
    const handleR = new Mesh(new SphereGeometry(0.045, 7, 7), matBrass);
    handleR.position.set(0.10, 1.08, 1.76);

    const canopy = new Mesh(new BoxGeometry(1.88, 0.12, 0.92), new MeshStandardMaterial({ color: TONE_ROOF_HEX.amber, roughness: 0.75 }));
    canopy.position.set(0, 2.08, 2.04);
    canopy.rotation.x = 0.22;
    canopy.castShadow = true;
    for (const px of [-0.78, 0.78]) {
      const pCol = new Mesh(new CylinderGeometry(0.065, 0.075, 1.68, 8), matTimber);
      pCol.position.set(px, 1.18, 2.36);
      pCol.castShadow = true;
      hall.add(pCol);
    }

    // 좌우 격자 창문 + 꽃화분
    const winL = createFramedWindow(true);
    winL.position.set(-1.58, 1.68, 1.66);
    const winR = createFramedWindow(true);
    winR.position.set(1.58, 1.68, 1.66);

    // 박공지붕 + 돌 굴뚝 + 연기
    const roof = createPitchedRoof(4.9, 1.65, 3.45, TONE_ROOF_HEX.moss);
    roof.position.y = 2.80;

    const chimney = new Mesh(new BoxGeometry(0.56, 1.85, 0.56), matStoneDark);
    chimney.position.set(-1.85, 3.55, -0.65);
    chimney.castShadow = true;
    const chimneyRim = new Mesh(new BoxGeometry(0.68, 0.14, 0.68), matStone);
    chimneyRim.position.set(-1.85, 4.50, -0.65);

    hall.add(doorFrame, doorLeaf, handleL, handleR, canopy, winL, winR, roof, chimney, chimneyRim);
    parent.add(hall);
    colliders.push({ x: hx, z: hz + 0.15, r: 2.95 });

    // 굴뚝 연기 입자 4개 등록
    smokePuffs.length = 0;
    for (let s = 0; s < 4; s += 1) {
      const sm = new Mesh(new SphereGeometry(0.22, 8, 7), matSmoke);
      parent.add(sm);
      smokePuffs.push({
        mesh: sm,
        phase: s * 0.25,
        baseX: hx - 1.85,
        baseY: gy + 4.65,
        baseZ: hz - 0.65,
      });
    }

    // 우측 풍차 시계탑 (회관과 넉넉히 간격 분리)
    const mx = 4.45;
    const mz = -6.7;
    const mgy = getTerrainBaseHeight(mx, mz);
    const mill = new Group();
    mill.position.set(mx, mgy, mz);

    const mBase = new Mesh(new CylinderGeometry(1.22, 1.38, 0.95, 12), matStone);
    mBase.position.y = 0.47;
    mBase.castShadow = true;
    mBase.receiveShadow = true;

    const mTower = new Mesh(new CylinderGeometry(0.84, 1.16, 3.05, 14), matPlaster);
    mTower.position.y = 2.42;
    mTower.castShadow = true;
    mTower.receiveShadow = true;

    const mBalcony = new Mesh(new CylinderGeometry(1.26, 1.22, 0.12, 14), matWood);
    mBalcony.position.y = 1.15;
    mBalcony.castShadow = true;

    const mCap = new Mesh(new ConeGeometry(1.08, 1.28, 14), new MeshStandardMaterial({ color: TONE_ROOF_HEX.cerulean, roughness: 0.74 }));
    mCap.position.y = 4.55;
    mCap.castShadow = true;
    const mFinial = new Mesh(new SphereGeometry(0.12, 8, 8), matBrass);
    mFinial.position.y = 5.24;

    const mWin = createFramedWindow(false);
    mWin.scale.setScalar(0.76);
    mWin.position.set(0, 2.35, 1.02);

    const axle = new Mesh(new CylinderGeometry(0.10, 0.10, 0.65, 8), matTimber);
    axle.rotation.x = Math.PI * 0.5;
    axle.position.set(0, 3.55, 0.96);

    windmillBlades.position.set(mx, mgy + 3.55, mz + 1.25);

    mill.add(mBase, mTower, mBalcony, mCap, mFinial, mWin, axle);
    parent.add(mill, windmillBlades);
    colliders.push({ x: mx, z: mz, r: 1.55 });
  }

  /** 중앙 광장 우물 · 모닥불 · 이정표 · 오크통 */
  function buildPlazaCommons(parent: Group) {
    // 1. 중앙 원형 조약돌 광장 디스크
    const courtY = getTerrainBaseHeight(0, -1.6);
    for (let ring = 0; ring < 12; ring += 1) {
      const ang = (ring / 12) * Math.PI * 2;
      const cobble = new Mesh(new CylinderGeometry(0.46, 0.50, 0.05, 9), ring % 2 === 0 ? matStone : matStoneDark);
      cobble.position.set(Math.cos(ang) * 3.5, courtY + 0.02, -1.6 + Math.sin(ang) * 3.5);
      cobble.receiveShadow = true;
      parent.add(cobble);
    }

    // 2. 석조 소원 우물 (-3.8, -1.4)
    const wx = -3.8;
    const wz = -1.4;
    const wy = getTerrainBaseHeight(wx, wz);
    const well = new Group();
    well.position.set(wx, wy, wz);

    const wellBase = new Mesh(new CylinderGeometry(0.86, 0.94, 0.18, 14), matStoneDark);
    wellBase.position.y = 0.09;
    const wellWall = new Mesh(new CylinderGeometry(0.72, 0.76, 0.68, 14), matStone);
    wellWall.position.y = 0.44;
    wellWall.castShadow = true;
    wellWall.receiveShadow = true;
    const wellRim = new Mesh(new TorusGeometry(0.70, 0.09, 8, 16), matStoneDark);
    wellRim.rotation.x = Math.PI * 0.5;
    wellRim.position.y = 0.78;
    const wellWater = new Mesh(
      new CylinderGeometry(0.60, 0.60, 0.05, 12),
      new MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.2, metalness: 0.1 }),
    );
    wellWater.position.y = 0.66;

    for (const px of [-0.66, 0.66]) {
      const post = new Mesh(new BoxGeometry(0.11, 1.35, 0.11), matTimber);
      post.position.set(px, 1.12, 0);
      post.castShadow = true;
      well.add(post);
    }
    const winch = new Mesh(new CylinderGeometry(0.07, 0.07, 1.32, 8), matWood);
    winch.rotation.z = Math.PI * 0.5;
    winch.position.y = 1.46;
    const bucket = new Mesh(new CylinderGeometry(0.14, 0.11, 0.22, 8), matWood);
    bucket.position.set(0, 1.08, 0);
    const wellRoof = createPitchedRoof(1.62, 0.62, 1.24, TONE_ROOF_HEX.cerulean, false);
    wellRoof.position.y = 1.76;

    well.add(wellBase, wellWall, wellRim, wellWater, winch, bucket, wellRoof);
    parent.add(well);
    colliders.push({ x: wx, z: wz, r: 1.02 });

    // 3. 광장 모닥불 & 삼각대 & 다리 달린 벤치 (2.8, 1.0)
    const fx = 2.8;
    const fz = 1.0;
    const fy = getTerrainBaseHeight(fx, fz);
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2;
      const rock = new Mesh(new SphereGeometry(0.18, 8, 6), i % 2 === 0 ? matStone : matStoneDark);
      rock.position.set(fx + Math.cos(a) * 0.74, fy + 0.08, fz + Math.sin(a) * 0.74);
      rock.scale.set(1.1, 0.68, 0.95);
      rock.castShadow = true;
      parent.add(rock);
    }
    for (let l = 0; l < 3; l += 1) {
      const log = new Mesh(new CylinderGeometry(0.085, 0.095, 0.96, 7), matTimber);
      log.position.set(fx, fy + 0.12, fz);
      log.rotation.z = Math.PI * 0.5;
      log.rotation.y = (l * Math.PI) / 3 + 0.2;
      parent.add(log);
    }
    flameGroup.position.set(fx, fy + 0.12, fz);
    parent.add(flameGroup);
    colliders.push({ x: fx, z: fz, r: 0.92 });

    addWoodenBench(parent, fx + 1.95, fz - 0.15, -Math.PI * 0.45);
    addWoodenBench(parent, fx - 0.25, fz + 1.95, Math.PI);

    // 4. 나무 이정표 (-2.2, 1.9)
    const sx = -2.2;
    const sz = 1.9;
    const sy = getTerrainBaseHeight(sx, sz);
    const signGroup = new Group();
    signGroup.position.set(sx, sy, sz);
    const sPost = new Mesh(new CylinderGeometry(0.08, 0.10, 1.75, 8), matTimber);
    sPost.position.y = 0.86;
    sPost.castShadow = true;
    const board1 = new Mesh(new BoxGeometry(0.92, 0.20, 0.06), matWoodLight);
    board1.position.set(0.22, 1.48, 0);
    board1.rotation.y = 0.35;
    board1.castShadow = true;
    const board2 = new Mesh(new BoxGeometry(0.86, 0.20, 0.06), matWood);
    board2.position.set(-0.20, 1.20, 0);
    board2.rotation.y = -0.45;
    board2.castShadow = true;
    signGroup.add(sPost, board1, board2);
    parent.add(signGroup);
    colliders.push({ x: sx, z: sz, r: 0.38 });
  }

  /** 시냇물 횡단 아치 목교 + 연못 수련잎/연꽃/부들 갈대 */
  function buildBrookBridgeAndFlora(parent: Group) {
    const bridge = new Group();
    bridge.position.set(BRIDGE_X, 0, BRIDGE_Z);
    bridge.rotation.y = BRIDGE_YAW;

    const halfSpan = BRIDGE_BROOK.halfWidth + 1.55;
    const steps = 12;
    for (let i = 0; i <= steps; i += 1) {
      const u = (i / steps) * 2 - 1; // -1..1
      const lz = u * halfSpan;
      const archY = 0.32 + Math.cos(u * Math.PI * 0.5) * 0.44;
      const plank = new Mesh(new BoxGeometry(2.45, 0.12, 0.46), i % 2 === 0 ? matWood : matWoodLight);
      plank.position.set(0, archY, lz);
      plank.castShadow = true;
      plank.receiveShadow = true;
      bridge.add(plank);

      if (i % 3 === 0) {
        for (const side of [-1.14, 1.14]) {
          const post = new Mesh(new BoxGeometry(0.11, 0.78, 0.11), matTimber);
          post.position.set(side, archY + 0.38, lz);
          post.castShadow = true;
          bridge.add(post);
        }
      }
    }
    // 아치 난간 손잡이 줄
    for (const side of [-1.14, 1.14]) {
      for (let i = 0; i < steps; i += 1) {
        const u0 = (i / steps) * 2 - 1;
        const u1 = ((i + 1) / steps) * 2 - 1;
        const z0 = u0 * halfSpan;
        const z1 = u1 * halfSpan;
        const y0 = 0.74 + Math.cos(u0 * Math.PI * 0.5) * 0.44;
        const y1 = 0.74 + Math.cos(u1 * Math.PI * 0.5) * 0.44;
        const segLen = Math.hypot(z1 - z0, y1 - y0);
        const rail = new Mesh(new BoxGeometry(0.08, 0.08, segLen + 0.04), matWood);
        rail.position.set(side, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
        rail.rotation.x = -Math.atan2(y1 - y0, z1 - z0);
        bridge.add(rail);
      }
    }
    parent.add(bridge);

    // 연못 수련잎 & 연꽃 & 부들 갈대
    const matPad = new MeshStandardMaterial({ color: 0x3da352, roughness: 0.75 });
    const matLotus = new MeshStandardMaterial({ color: 0xf9a8d4, roughness: 0.65 });
    const padCoords: readonly [number, number, boolean][] = [
      [4.2, brookProfile(4.2).centerZ - 0.6, true],
      [5.1, brookProfile(5.1).centerZ + 0.9, false],
      [3.4, brookProfile(3.4).centerZ + 0.5, true],
      [-2.5, brookProfile(-2.5).centerZ - 0.3, false],
      [11.6, brookProfile(11.6).centerZ + 0.4, true],
    ];
    padCoords.forEach(([px, pz, hasFlower]) => {
      const pad = new Mesh(new CylinderGeometry(0.36, 0.36, 0.03, 12), matPad);
      pad.position.set(px, -0.07, pz);
      parent.add(pad);
      if (hasFlower) {
        const lotus = new Mesh(new ConeGeometry(0.14, 0.16, 7), matLotus);
        lotus.position.set(px, 0.01, pz);
        lotus.rotation.x = Math.PI;
        parent.add(lotus);
      }
    });

    // 강변 부들(Cattails)
    for (const rx of [-6.5, -1.2, 3.2, 10.8, 14.2]) {
      const bp = brookProfile(rx);
      const rz = bp.centerZ - bp.halfWidth - 0.15;
      const stem = new Mesh(new CylinderGeometry(0.025, 0.03, 0.85, 6), matLeafRich);
      stem.position.set(rx, 0.18, rz);
      const head = new Mesh(new CylinderGeometry(0.055, 0.055, 0.24, 7), matTimber);
      head.position.set(rx, 0.48, rz);
      parent.add(stem, head);
    }
  }

  /** 각 Objective 초원 공방 캠프 및 사령관 정원 파빌리온 구축 */
  function buildZoneStructures(parent: Group, zone: WorldZoneSpec) {
    if (zone.kind === "garden") {
      const gy = getTerrainBaseHeight(zone.x, zone.z);
      const g = new Group();
      g.position.set(zone.x, gy, zone.z);

      const stepOuter = new Mesh(new CylinderGeometry(2.45, 2.65, 0.18, 8), matStoneDark);
      stepOuter.position.y = 0.09;
      stepOuter.receiveShadow = true;
      const deck = new Mesh(new CylinderGeometry(2.15, 2.30, 0.24, 8), matStone);
      deck.position.y = 0.26;
      deck.receiveShadow = true;
      g.add(stepOuter, deck);

      for (let k = 0; k < 6; k += 1) {
        const a = (k / 6) * Math.PI * 2 + 0.26;
        const col = new Mesh(new CylinderGeometry(0.11, 0.13, 1.85, 10), matPlaster);
        col.position.set(Math.cos(a) * 1.72, 1.28, Math.sin(a) * 1.72);
        col.castShadow = true;
        g.add(col);
      }
      const frieze = new Mesh(new CylinderGeometry(1.96, 1.96, 0.16, 8), matWood);
      frieze.position.y = 2.24;
      const pRoof1 = new Mesh(new ConeGeometry(2.42, 0.92, 8), new MeshStandardMaterial({ color: TONE_ROOF_HEX.cerulean, roughness: 0.74 }));
      pRoof1.position.y = 2.75;
      pRoof1.castShadow = true;
      const pRoof2 = new Mesh(new ConeGeometry(1.38, 0.72, 8), new MeshStandardMaterial({ color: TONE_ROOF_HEX.cerulean, roughness: 0.74 }));
      pRoof2.position.y = 3.32;
      pRoof2.castShadow = true;
      const finial = new Mesh(new SphereGeometry(0.13, 8, 8), matBrass);
      finial.position.y = 3.74;

      g.add(frieze, pRoof1, pRoof2, finial);
      parent.add(g);
      // 파빌리온 언덕 양옆으로 화사한 분홍 벚나무 3그루와 벤치·가로등 배치
      addWoodenBench(parent, zone.x - 3.1, zone.z + 0.6, 0.65);
      addTree(parent, zone.x + 3.6, zone.z + 1.2, 1.12, "blossom");
      addTree(parent, zone.x - 3.6, zone.z + 2.0, 1.02, "blossom");
      addTree(parent, zone.x + 2.8, zone.z - 2.6, 0.95, "blossom");
      addHangingStreetlamp(parent, zone.x - 2.3, zone.z - 2.4, 0.4);
      return;
    }

    if (zone.kind !== "outpost") return;

    // 1. 하프팀버 공방 오두막
    const cx = zone.x - 2.15;
    const cz = zone.z - 2.35;
    const cgy = getTerrainBaseHeight(cx, cz);
    const cottage = new Group();
    cottage.position.set(cx, cgy, cz);
    const faceYaw = Math.atan2(-cx, -cz) * 0.25 + 0.22;
    cottage.rotation.y = faceYaw;

    const cPlinth = new Mesh(new BoxGeometry(2.95, 0.24, 2.45), matStone);
    cPlinth.position.y = 0.12;
    cPlinth.receiveShadow = true;

    const cBody = new Mesh(new BoxGeometry(2.68, 1.75, 2.18), matPlaster);
    cBody.position.y = 1.10;
    cBody.castShadow = true;
    cBody.receiveShadow = true;

    for (const px of [-1.33, 1.33]) {
      for (const pz of [-1.08, 1.08]) {
        const post = new Mesh(new BoxGeometry(0.11, 1.78, 0.11), matTimber);
        post.position.set(px, 1.10, pz);
        cottage.add(post);
      }
    }
    const topBeam = new Mesh(new BoxGeometry(2.74, 0.10, 2.24), matTimber);
    topBeam.position.y = 1.96;

    const cDoor = new Mesh(new BoxGeometry(0.68, 1.22, 0.10), matWood);
    cDoor.position.set(-0.48, 0.84, 1.10);
    const cKnob = new Mesh(new SphereGeometry(0.04, 6, 6), matBrass);
    cKnob.position.set(-0.24, 0.82, 1.17);
    const cStep = new Mesh(new BoxGeometry(0.88, 0.14, 0.42), matStoneDark);
    cStep.position.set(-0.48, 0.07, 1.32);

    const cWin = createFramedWindow(true);
    cWin.scale.setScalar(0.82);
    cWin.position.set(0.56, 1.16, 1.10);

    const cRoof = createPitchedRoof(2.82, 1.18, 2.32, TONE_ROOF_HEX[zone.roofTone]);
    cRoof.position.y = 1.98;

    const cChimney = new Mesh(new BoxGeometry(0.42, 1.25, 0.42), matStoneDark);
    cChimney.position.set(0.85, 2.55, -0.45);
    cChimney.castShadow = true;

    cottage.add(cPlinth, cBody, topBeam, cDoor, cKnob, cStep, cWin, cRoof, cChimney);
    parent.add(cottage);
    colliders.push({ x: cx, z: cz, r: 1.78 });

    // 2. 캠프 상징 컬러 깃발 폴대
    const fx = zone.x + 2.35;
    const fz = zone.z - 2.45;
    const fgy = getTerrainBaseHeight(fx, fz);
    const pole = new Mesh(new CylinderGeometry(0.055, 0.075, 2.85, 8), matWood);
    pole.position.set(fx, fgy + 1.42, fz);
    pole.castShadow = true;
    const finial = new Mesh(new SphereGeometry(0.10, 8, 8), matBrass);
    finial.position.set(fx, fgy + 2.88, fz);
    const bannerMat = new MeshStandardMaterial({ color: TONE_ROOF_HEX[zone.roofTone], roughness: 0.65, side: DoubleSide });
    const banner = new Mesh(new BoxGeometry(0.92, 0.46, 0.03), bannerMat);
    banner.position.set(fx + 0.46, fgy + 2.52, fz);
    banner.castShadow = true;
    parent.add(pole, finial, banner);
    bannerMeshes.push({ mesh: banner, baseRotY: 0.15, phase: zone.x * 0.3 + zone.z * 0.2 });

    // 3. 4족 오크 작전 브리핑 테이블 + 양피지 지도 + 전술 말 + 황동 랜턴
    const tx = zone.x + 0.55;
    const tz = zone.z - 0.45;
    const tgy = getTerrainBaseHeight(tx, tz);
    const tableGroup = new Group();
    tableGroup.position.set(tx, tgy, tz);

    const tTop = new Mesh(new CylinderGeometry(0.96, 0.96, 0.10, 16), matWood);
    tTop.position.y = 0.64;
    tTop.castShadow = true;
    tTop.receiveShadow = true;
    for (let l = 0; l < 4; l += 1) {
      const la = (l / 4) * Math.PI * 2 + Math.PI * 0.25;
      const leg = new Mesh(new CylinderGeometry(0.065, 0.055, 0.62, 7), matTimber);
      leg.position.set(Math.cos(la) * 0.62, 0.31, Math.sin(la) * 0.62);
      leg.castShadow = true;
      tableGroup.add(leg);
    }
    const mapSheet = new Mesh(new BoxGeometry(1.02, 0.03, 0.76), matParchment);
    mapSheet.position.y = 0.70;
    mapSheet.rotation.y = 0.18;
    const pin1 = new Mesh(new ConeGeometry(0.055, 0.14, 7), new MeshStandardMaterial({ color: TONE_ROOF_HEX[zone.roofTone] }));
    pin1.position.set(-0.18, 0.78, 0.08);
    const pin2 = new Mesh(new CylinderGeometry(0.045, 0.045, 0.11, 7), matBrass);
    pin2.position.set(0.22, 0.76, -0.12);
    const deskLamp = new Mesh(new CylinderGeometry(0.07, 0.09, 0.18, 7), matLanternGlass);
    deskLamp.position.set(-0.52, 0.78, -0.35);

    tableGroup.add(tTop, mapSheet, pin1, pin2, deskLamp);
    parent.add(tableGroup);
    colliders.push({ x: tx, z: tz, r: 0.92 });

    // 4. 공방 전문 작업 설비 (대장간 모루 + 필드 터미널 OR 황동 굴절 망원경 + 서적 상자)
    if (zone.fullWorkshop !== false) {
      // 대장간 참나무 그루터기 & 뿔 달린 단조 모루(Horned Anvil) + 망치
      const ax = zone.x - 3.25;
      const az = zone.z + 0.95;
      const agy = getTerrainBaseHeight(ax, az);
      const forge = new Group();
      forge.position.set(ax, agy, az);
      forge.rotation.y = 0.38;

      const stump = new Mesh(new CylinderGeometry(0.44, 0.52, 0.52, 12), matWood);
      stump.position.y = 0.26;
      stump.castShadow = true;
      const anvilFoot = new Mesh(new BoxGeometry(0.48, 0.12, 0.30), matIron);
      anvilFoot.position.y = 0.58;
      const anvilWaist = new Mesh(new BoxGeometry(0.32, 0.14, 0.22), matIron);
      anvilWaist.position.y = 0.70;
      const anvilFace = new Mesh(new BoxGeometry(0.56, 0.14, 0.26), matIron);
      anvilFace.position.y = 0.82;
      anvilFace.castShadow = true;
      const anvilHorn = new Mesh(new ConeGeometry(0.11, 0.34, 8), matIron);
      anvilHorn.rotation.z = -Math.PI * 0.5;
      anvilHorn.position.set(0.42, 0.82, 0);
      const hammerHead = new Mesh(new BoxGeometry(0.16, 0.08, 0.08), matIron);
      hammerHead.position.set(-0.10, 0.93, 0.04);
      const hammerHandle = new Mesh(new CylinderGeometry(0.02, 0.02, 0.28, 6), matWoodLight);
      hammerHandle.rotation.z = 1.35;
      hammerHandle.position.set(-0.22, 0.91, 0.08);

      forge.add(stump, anvilFoot, anvilWaist, anvilFace, anvilHorn, hammerHead, hammerHandle);
      parent.add(forge);
      colliders.push({ x: ax, z: az, r: 0.65 });

      // 필드 텔레메트리 책상 + 레트로 CRT 모니터 + 키보드
      const rx = zone.x + 3.15;
      const rz = zone.z + 0.45;
      const rgy = getTerrainBaseHeight(rx, rz);
      const rigDesk = new Group();
      rigDesk.position.set(rx, rgy, rz);
      rigDesk.rotation.y = -0.62;

      const dTop = new Mesh(new BoxGeometry(1.12, 0.08, 0.68), matWood);
      dTop.position.y = 0.62;
      dTop.castShadow = true;
      for (const lx of [-0.46, 0.46]) {
        for (const lz of [-0.24, 0.24]) {
          const dLeg = new Mesh(new BoxGeometry(0.07, 0.62, 0.07), matTimber);
          dLeg.position.set(lx, 0.31, lz);
          rigDesk.add(dLeg);
        }
      }
      const crtShell = new Mesh(new BoxGeometry(0.66, 0.54, 0.46), matStone);
      crtShell.position.set(0, 0.92, -0.06);
      crtShell.castShadow = true;
      const crtScreen = new Mesh(new BoxGeometry(0.52, 0.38, 0.05), matScreen);
      crtScreen.position.set(0, 0.93, 0.16);
      const kbd = new Mesh(new BoxGeometry(0.48, 0.04, 0.18), matIron);
      kbd.position.set(0, 0.68, 0.22);

      rigDesk.add(dTop, crtShell, crtScreen, kbd);
      parent.add(rigDesk);
      colliders.push({ x: rx, z: rz, r: 0.72 });
    } else {
      // 황동 3각대 천문 망원경 + 서적 상자
      const ox = zone.x + 2.75;
      const oz = zone.z + 0.95;
      const ogy = getTerrainBaseHeight(ox, oz);
      const obs = new Group();
      obs.position.set(ox, ogy, oz);
      obs.rotation.y = 0.45;

      for (let k = 0; k < 3; k += 1) {
        const ka = (k / 3) * Math.PI * 2;
        const tLeg = new Mesh(new CylinderGeometry(0.035, 0.025, 1.05, 7), matTimber);
        tLeg.position.set(Math.cos(ka) * 0.22, 0.48, Math.sin(ka) * 0.22);
        tLeg.rotation.z = Math.cos(ka) * 0.26;
        tLeg.rotation.x = -Math.sin(ka) * 0.26;
        obs.add(tLeg);
      }
      const mount = new Mesh(new SphereGeometry(0.11, 8, 8), matIron);
      mount.position.y = 0.98;
      const tube = new Mesh(new CylinderGeometry(0.09, 0.13, 1.08, 12), matBrass);
      tube.position.set(0, 1.12, 0.05);
      tube.rotation.x = -1.05;
      tube.castShadow = true;
      const lens = new Mesh(new CylinderGeometry(0.135, 0.135, 0.08, 12), matScreen);
      lens.position.set(0, 1.38, 0.50);
      lens.rotation.x = -1.05;

      const bookCrate = new Mesh(new BoxGeometry(0.58, 0.42, 0.48), matWood);
      bookCrate.position.set(-0.78, 0.21, 0.22);
      bookCrate.castShadow = true;
      const book1 = new Mesh(new BoxGeometry(0.32, 0.08, 0.24), new MeshStandardMaterial({ color: TONE_ROOF_HEX[zone.roofTone] }));
      book1.position.set(-0.78, 0.46, 0.22);
      const book2 = new Mesh(new BoxGeometry(0.28, 0.08, 0.22), matBrass);
      book2.position.set(-0.76, 0.54, 0.22);
      book2.rotation.y = 0.25;

      obs.add(mount, tube, lens, bookCrate, book1, book2);
      parent.add(obs);
      colliders.push({ x: ox, z: oz, r: 0.72 });
    }

    // 5. 캠프 외곽 목장 울타리 + 가로등 + 주변 나무/수풀
    addFenceRun(parent, zone.x - 4.2, zone.z - 4.1, zone.x + 1.4, zone.z - 4.4, 4);
    addHangingStreetlamp(parent, zone.x + 1.95, zone.z - 2.1, -0.5);
    addTree(parent, zone.x - 4.5, zone.z - 2.4, 1.05, "oak");
    addTree(parent, zone.x + 4.3, zone.z - 1.8, 0.94, "pine");
    addBushAndRockCluster(parent, zone.x - 3.6, zone.z + 2.8, 0.95);
  }

  /** 지형 정점 좌표/컬러 갱신 및 풀잎·들꽃 인스탄싱 배치 */
  function rebuildWorld(zones: readonly WorldZoneSpec[]) {
    while (dynamicWorldGroup.children.length > 0) {
      dynamicWorldGroup.remove(dynamicWorldGroup.children[0]!);
    }
    streetlampAnchors.length = 0;
    colliders = [];
    bannerMeshes.length = 0;
    currentZones = zones;

    // 1. 광장(0,0) ↔ 각 구역 간 자연스러운 초원 오솔길 세그먼트 생성
    roadSegments = [];
    for (const zSpec of zones) {
      if (zSpec.kind === "plaza") continue;
      if (zSpec.kind === "garden") {
        // 광장 → 아치 다리 → 사령관 정원 언덕 2단 연결
        roadSegments.push({ ax: 0.8, az: 1.2, bx: BRIDGE_X, bz: BRIDGE_Z, width: 1.35 });
        roadSegments.push({ ax: BRIDGE_X, az: BRIDGE_Z, bx: zSpec.x, bz: zSpec.z, width: 1.30 });
      } else {
        roadSegments.push({ ax: 0, az: -1.2, bx: zSpec.x * 0.92, bz: zSpec.z * 0.92, width: 1.35 });
      }
    }

    // 2. 지형 정점 높이 & 정점 컬러 페인팅
    const posAttr = terrainGeo.attributes["position"] as BufferAttribute;
    const cGrassRich = new Color(0x4eb956);
    const cGrassSun = new Color(0x6ad15e);
    const cGrassDeep = new Color(0x3b9b4b);
    const cPath = new Color(0xdac49b);
    const cCobble = new Color(0xc7ccd4);
    const cBank = new Color(0xe2cda2);
    const cMountain = new Color(0x568d7a);
    const tmpCol = new Color();

    for (let i = 0; i < posAttr.count; i += 1) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const vy = getTerrainBaseHeight(vx, vz);
      posAttr.setY(i, vy);

      // 초원 기본 명암 패치
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

      // 시냇물 수로 주변에만 모래/자갈 강변 블렌딩 (건조한 원경 구릉 골짜기에는 섞이지 않게 제한!)
      if (Math.abs(vx) < 48) {
        const bp = brookProfile(vx);
        if (Math.abs(vz - bp.centerZ) < bp.halfWidth + 2.2 && vy < 0.22) {
          const bw = 1 - smoothstep(-0.18, 0.22, vy);
          tmpCol.lerp(cBank, bw * 0.88);
        }
      }

      // 원경 산맥 안개빛 녹청색 블렌딩
      const rDist = Math.hypot(vx, vz);
      if (rDist > 46) {
        const mw = smoothstep(46, 92, rDist);
        tmpCol.lerp(cMountain, mw * 0.65);
      }

      terrainColorAttr.setXYZ(i, tmpCol.r, tmpCol.g, tmpCol.b);
    }
    posAttr.needsUpdate = true;
    terrainColorAttr.needsUpdate = true;
    terrainGeo.computeVertexNormals();

    // 3. 본부 길드 회관 · 광장 공용 오브젝트 · 시냇물 아치교 · 캠프 구조물 생성
    buildGrandGuildHall(dynamicWorldGroup);
    buildPlazaCommons(dynamicWorldGroup);
    buildBrookBridgeAndFlora(dynamicWorldGroup);
    for (const zSpec of zones) {
      buildZoneStructures(dynamicWorldGroup, zSpec);
    }

    // 4. 광장 및 초원 외곽 풍경림 · 목장 울타리 · 가로등 배치
    addHangingStreetlamp(dynamicWorldGroup, -2.9, -3.5, 0.4);
    addHangingStreetlamp(dynamicWorldGroup, 3.1, -3.4, -0.4);
    addHangingStreetlamp(dynamicWorldGroup, 5.4, 5.6, -0.8);

    const scenicTrees: readonly [number, number, number, "oak" | "pine" | "blossom"][] = [
      [-7.2, -5.8, 1.18, "oak"],
      [-8.6, 1.5, 1.05, "pine"],
      [-5.8, 6.4, 1.08, "blossom"],
      [8.6, -4.2, 1.12, "oak"],
      [11.2, 1.8, 0.98, "pine"],
      [-18.5, -15.0, 1.28, "pine"],
      [0.5, -18.5, 1.25, "oak"],
      [19.5, -14.8, 1.22, "pine"],
      [-23.0, 8.5, 1.30, "oak"],
      [-14.5, 21.0, 1.24, "pine"],
      [4.5, 22.5, 1.18, "oak"],
      [23.5, 6.8, 1.26, "pine"],
      [-31.0, -6.0, 1.42, "pine"],
      [29.5, -8.5, 1.38, "oak"],
      [26.0, 21.5, 1.35, "pine"],
      [-26.5, -24.0, 1.40, "oak"],
    ];
    scenicTrees.forEach(([tx, tz, sc, kind]) => {
      // 캠프 중심과 겹치지 않을 때만 식재
      if (zones.some((z) => z.kind !== "plaza" && Math.hypot(tx - z.x, tz - z.z) < 5.6)) return;
      addTree(dynamicWorldGroup, tx, tz, sc, kind);
    });

    addFenceRun(dynamicWorldGroup, -9.8, -8.8, -5.2, -9.4, 4);
    addFenceRun(dynamicWorldGroup, 6.8, -8.6, 11.4, -7.2, 4);
    addBushAndRockCluster(dynamicWorldGroup, -5.6, -3.2, 1.0);
    addBushAndRockCluster(dynamicWorldGroup, 6.4, -2.4, 0.92);
    addBushAndRockCluster(dynamicWorldGroup, -1.2, 6.2, 1.05);

    // 5. 풀잎(InstancedMesh) & 들꽃(InstancedMesh) 배치 — 도로·수면·건물 내부는 자동 회피!
    const dummy = new Object3D();
    const grassColors = [new Color(0x52c258), new Color(0x67d25f), new Color(0x44ad50), new Color(0x78d966)];
    let gCount = 0;
    for (let attempt = 0; attempt < MAX_GRASS * 2 && gCount < MAX_GRASS; attempt += 1) {
      const u1 = hash2(attempt * 1.13, 7.31);
      const u2 = hash2(attempt * 2.71, 19.4);
      const rad = Math.sqrt(u1) * 44.0;
      const ang = u2 * Math.PI * 2;
      const gx = Math.cos(ang) * rad;
      const gz = Math.sin(ang) * rad;
      const gy = getTerrainBaseHeight(gx, gz);
      if (gy < 0.14) continue;
      const rd = minRoadDistance(gx, gz);
      if (rd.dist < rd.halfWidth + 0.35) continue;
      if (colliders.some((c) => Math.hypot(gx - c.x, gz - c.z) < c.r + 0.25)) continue;

      dummy.position.set(gx, gy - 0.02, gz);
      dummy.rotation.set(
        (hash2(gx, gz) - 0.5) * 0.22,
        hash2(gz, gx) * Math.PI * 2,
        (hash2(gx + 3, gz) - 0.5) * 0.22,
      );
      const sc = 0.72 + hash2(gx * 2, gz * 2) * 0.75;
      dummy.scale.set(sc, sc * (0.85 + hash2(attempt, 3.1) * 0.55), sc);
      dummy.updateMatrix();
      grassInstanced.setMatrixAt(gCount, dummy.matrix);
      grassInstanced.setColorAt(gCount, grassColors[attempt % grassColors.length]!);
      gCount += 1;
    }
    grassInstanced.count = gCount;
    grassInstanced.instanceMatrix.needsUpdate = true;
    if (grassInstanced.instanceColor) grassInstanced.instanceColor.needsUpdate = true;

    const flowerPalette = [
      new Color(0xffffff), // 데이지
      new Color(0xfde047), // 미나리아재비 노랑
      new Color(0xf9a8d4), // 코스모스 핑크
      new Color(0x93c5fd), // 물망초 하늘색
      new Color(0xfda4af), // 코랄 로즈
    ];
    let fCount = 0;
    for (let attempt = 0; attempt < MAX_FLOWERS * 3 && fCount < MAX_FLOWERS; attempt += 1) {
      const u1 = hash2(attempt * 3.17 + 50, 11.7);
      const u2 = hash2(attempt * 5.09 + 20, 29.3);
      const rad = 3.5 + Math.sqrt(u1) * 39.0;
      const ang = u2 * Math.PI * 2;
      const fx = Math.cos(ang) * rad;
      const fz = Math.sin(ang) * rad;
      const fy = getTerrainBaseHeight(fx, fz);
      if (fy < 0.18) continue;
      const rd = minRoadDistance(fx, fz);
      if (rd.dist < rd.halfWidth + 0.45) continue;
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

  const ffMatrix = new Matrix4();
  const ffPos = new Vector3();
  const ffQuat = new Quaternion();
  const ffScale = new Vector3();

  scene.add(root);

  return {
    group: root,
    streetlampAnchors,
    syncZones(zones) {
      const sig = zones.map((z) => `${z.id}:${z.x}:${z.z}:${z.roofTone}`).join("|");
      if (sig === currentSignature) return;
      currentSignature = sig;
      rebuildWorld(zones);
    },
    getGroundHeight,
    isWalkable,
    resolveMovement,
    update(elapsed, nightFactor, sunDir) {
      windTimeUniform.value = elapsed;
      windmillBlades.rotation.z = -elapsed * 0.95;

      const flick1 = 0.88 + Math.sin(elapsed * 13.5) * 0.16;
      const flick2 = 0.92 + Math.cos(elapsed * 17.0) * 0.14;
      flameOuter.scale.set(1, flick1, 1);
      flameCore.scale.set(1, flick2, 1);

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

      // 캠프 깃발 바람 물결
      for (const bm of bannerMeshes) {
        bm.mesh.rotation.y = bm.baseRotY + Math.sin(elapsed * 3.4 + bm.phase) * 0.18;
      }

      matWindow.emissiveIntensity = 0.12 + nightFactor * 1.45;
      matLanternGlass.emissiveIntensity = 0.18 + nightFactor * 1.85;
      cloudGroup.rotation.y = elapsed * 0.012;

      brookMat.uniforms["uTime"]!.value = elapsed;
      brookMat.uniforms["uNight"]!.value = nightFactor;
      (brookMat.uniforms["uSunDir"]!.value as Vector3).copy(sunDir);

      // 야간 반딧불이 부유
      const ffVisibility = Math.max(0, (nightFactor - 0.22) / 0.78);
      fireflyMat.opacity = ffVisibility * 0.92;
      fireflyInstanced.visible = ffVisibility > 0.02;
      if (fireflyInstanced.visible) {
        for (let i = 0; i < MAX_FIREFLIES; i += 1) {
          const seed = fireflySeeds[i]!;
          const fx = seed.x + Math.sin(elapsed * 0.8 + seed.phase) * 1.1;
          const fz = seed.z + Math.cos(elapsed * 0.7 + seed.phase) * 1.1;
          const fy = Math.max(0.1, getTerrainBaseHeight(fx, fz)) + 0.65 + Math.sin(elapsed * 2.1 + seed.phase) * 0.38;
          const pulse = (0.55 + 0.45 * Math.sin(elapsed * 4.2 + seed.phase * 2.3)) * ffVisibility;
          ffPos.set(fx, fy, fz);
          ffScale.setScalar(Math.max(0.01, pulse));
          ffMatrix.compose(ffPos, ffQuat, ffScale);
          fireflyInstanced.setMatrixAt(i, ffMatrix);
        }
        fireflyInstanced.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      terrainGeo.dispose();
      terrainMat.dispose();
      brookGeo.dispose();
      brookMat.dispose();
      grassBladeGeo.dispose();
      grassMat.dispose();
      flowerHeadGeo.dispose();
      flowerMat.dispose();
      fireflyGeo.dispose();
      fireflyMat.dispose();
      scene.remove(root);
    },
  };
}
