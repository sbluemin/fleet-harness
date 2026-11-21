import {
  AdditiveBlending,
  BackSide,
  Color,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  FogExp2,
  GLSL3,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  PointLight,
  Quaternion,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";

import type { WorldTimeMode, WorldWeatherMode } from "../../shared/world-types.js";

/**
 * 넓은 초원 마을 전용 낮 · 노을 · 밤 스카이돔 + 태양/달 광역 그림자 광원(2048px PCF) + 야간 동적 PointLight 풀.
 */

const SKY_VERTEX = /* glsl */ `
out vec3 vWorldDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SKY_FRAGMENT = /* glsl */ `
in vec3 vWorldDir;
out vec4 fragColor;

uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
uniform float uNight;
uniform float uTime;

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbmCloud(vec2 p) {
  float v = 0.0;
  float amp = 0.52;
  for (int i = 0; i < 4; i++) {
    v += amp * vnoise2(p);
    p = mat2(1.62, 1.18, -1.18, 1.62) * p + vec2(17.1, 31.7);
    amp *= 0.48;
  }
  return v;
}

void main() {
  vec3 dir = normalize(vWorldDir);
  vec3 sun = normalize(uSunDir);
  float h = clamp(dir.y * 0.88 + 0.12, 0.0, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyTop, pow(h, 0.62));
  float sunset = clamp(1.0 - abs(uNight - 0.38) * 2.55, 0.0, 1.0);

  // 태양 및 황혼 코로나
  float sunDot = dot(dir, sun);
  col += vec3(1.0, 0.90, 0.60) * pow(max(sunDot, 0.0), 28.0) * 0.48 * (1.0 - uNight * 0.78);
  if (sunDot > 0.9965 && uNight < 0.72) {
    col = mix(col, vec3(1.25, 1.20, 1.05), 0.95);
  }

  // 밤하늘 초승달 & 둥글게 반짝이는 별자리 (격자 사각형 아티팩트 방지)
  vec3 moonDir = normalize(vec3(-0.52, 0.66, -0.54));
  float moonDot = dot(dir, moonDir);
  if (uNight > 0.30 && dir.y > 0.02) {
    vec3 sg = floor(dir * 155.0);
    float st = hash31(sg);
    if (st > 0.9915) {
      vec3 starCenter = normalize(sg + vec3(0.5));
      float dStar = length(dir - starCenter) * 155.0;
      float starDisc = smoothstep(0.36, 0.05, dStar);
      float tw = 0.55 + 0.45 * sin(uTime * 3.1 + st * 90.0);
      col += vec3(1.25, 1.22, 1.10) * starDisc * tw * (uNight - 0.30) * 1.55 * smoothstep(0.02, 0.22, dir.y);
    }
    col += vec3(0.50, 0.68, 1.0) * pow(max(moonDot, 0.0), 42.0) * 0.42 * uNight;
    if (moonDot > 0.9972) {
      col = mix(col, vec3(1.30, 1.26, 1.06), smoothstep(0.9972, 0.9978, moonDot) * uNight);
    }
  }

  // 부드러운 지브리풍 솜사탕 뭉게구름 (0 추가 draw call, 지평선 자연 페이드)
  if (dir.y > 0.04) {
    vec2 cloudUv = dir.xz / (dir.y + 0.22);
    vec2 drift = vec2(uTime * 0.011, uTime * 0.005);
    float cBase = fbmCloud(cloudUv * 0.85 + drift);
    float cDetail = fbmCloud(cloudUv * 1.95 - drift * 1.35 + vec2(4.2, 9.1));
    float density = smoothstep(0.47, 0.78, cBase * 0.76 + cDetail * 0.34);
    float horizonFade = smoothstep(0.05, 0.23, dir.y) * smoothstep(0.98, 0.55, dir.y);
    float cloudAlpha = density * horizonFade * mix(0.84, 0.28, uNight);

    if (cloudAlpha > 0.004) {
      // 태양 방향 샘플링으로 구름 윗면(하이라이트)과 아랫면(파스텔 그림자) 입체감 부여
      float cLit = fbmCloud((cloudUv + sun.xz * 0.16) * 0.85 + drift);
      float shade = clamp(0.55 + (cBase - cLit) * 2.4 + max(sunDot, 0.0) * 0.25, 0.0, 1.0);

      vec3 dayTop = vec3(1.00, 0.99, 0.96);
      vec3 dayUnder = vec3(0.76, 0.89, 0.99);
      vec3 setTop = vec3(1.00, 0.82, 0.58);
      vec3 setUnder = vec3(0.68, 0.44, 0.58);
      vec3 nightTop = vec3(0.32, 0.43, 0.66);
      vec3 nightUnder = vec3(0.14, 0.20, 0.36);

      vec3 cTop = mix(mix(dayTop, setTop, sunset), nightTop, smoothstep(0.45, 0.92, uNight));
      vec3 cUnder = mix(mix(dayUnder, setUnder, sunset), nightUnder, smoothstep(0.45, 0.92, uNight));
      vec3 cloudCol = mix(cUnder, cTop, shade);
      // 태양 주변 황금 은테
      cloudCol += vec3(1.0, 0.86, 0.62) * pow(max(sunDot, 0.0), 10.0) * 0.28 * (1.0 - uNight * 0.85);
      col = mix(col, cloudCol, cloudAlpha);
    }
  }

  // 3겹 원경 산맥 실루엣 (정수 배수 방위각 고조파로 360° 이음새 0 + 대기 원근 안개 그라데이션)
  if (dir.y > -0.06 && dir.y < 0.20) {
    float az = atan(dir.z, dir.x);

    // 1겹 (최원경 알프스 설산 능선)
    float hFar = 0.088
      + 0.032 * sin(az * 3.0 + 0.6)
      + 0.020 * sin(az * 7.0 - 1.1)
      + 0.011 * cos(az * 13.0 + 2.3)
      + 0.005 * sin(az * 23.0 + 0.4);
    float mFar = smoothstep(hFar + 0.0035, hFar - 0.0035, dir.y);

    // 2겹 (중원경 완만한 산줄기)
    float hMid = 0.056
      + 0.022 * sin(az * 4.0 + 2.2)
      + 0.013 * cos(az * 9.0 + 0.5)
      + 0.007 * sin(az * 17.0 - 1.4);
    float mMid = smoothstep(hMid + 0.0032, hMid - 0.0032, dir.y);

    // 3겹 (근원경 숲 언덕 능선)
    float hNear = 0.030
      + 0.013 * sin(az * 5.0 - 0.9)
      + 0.008 * cos(az * 11.0 + 1.8)
      + 0.004 * sin(az * 21.0 + 0.7);
    float mNear = smoothstep(hNear + 0.0028, hNear - 0.0028, dir.y);

    vec3 farDay = mix(vec3(0.56, 0.76, 0.92), uSkyHorizon, 0.58);
    vec3 farSet = mix(vec3(0.68, 0.50, 0.64), uSkyHorizon, 0.52);
    vec3 farNight = mix(vec3(0.14, 0.21, 0.39), uSkyHorizon, 0.45);
    vec3 cFar = mix(mix(farDay, farSet, sunset), farNight, smoothstep(0.42, 0.92, uNight));
    // 최원경 봉우리 정상에 은은한 설산 햇살 림
    float ridgeSnow = smoothstep(hFar - 0.018, hFar - 0.002, dir.y) * (1.0 - uNight * 0.75);
    cFar = mix(cFar, vec3(0.95, 0.97, 1.0), ridgeSnow * 0.22);

    vec3 midDay = mix(vec3(0.39, 0.64, 0.78), uSkyHorizon, 0.36);
    vec3 midSet = mix(vec3(0.49, 0.35, 0.52), uSkyHorizon, 0.34);
    vec3 midNight = mix(vec3(0.10, 0.16, 0.31), uSkyHorizon, 0.30);
    vec3 cMid = mix(mix(midDay, midSet, sunset), midNight, smoothstep(0.42, 0.92, uNight));

    vec3 nearDay = mix(vec3(0.31, 0.58, 0.58), uSkyHorizon, 0.18);
    vec3 nearSet = mix(vec3(0.36, 0.26, 0.38), uSkyHorizon, 0.20);
    vec3 nearNight = mix(vec3(0.07, 0.12, 0.23), uSkyHorizon, 0.18);
    vec3 cNear = mix(mix(nearDay, nearSet, sunset), nearNight, smoothstep(0.42, 0.92, uNight));

    // 산기슭 대기 원근 안개 그라데이션
    float baseMistFar = smoothstep(0.08, -0.01, dir.y) * 0.55;
    float baseMistMid = smoothstep(0.055, -0.01, dir.y) * 0.45;
    float baseMistNear = smoothstep(0.025, -0.02, dir.y) * 0.42;

    col = mix(col, mix(cFar, uSkyHorizon, baseMistFar), mFar);
    col = mix(col, mix(cMid, uSkyHorizon, baseMistMid), mMid);
    col = mix(col, mix(cNear, uSkyHorizon, baseMistNear), mNear);
  }

  fragColor = vec4(col, 1.0);
}
`;

const RAINBOW_VERTEX = /* glsl */ `
out vec2 vLocalPos;
void main() {
  vLocalPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RAINBOW_FRAGMENT = /* glsl */ `
in vec2 vLocalPos;
out vec4 fragColor;

uniform float uAlpha;
uniform float uTime;

vec3 rainbowSpectrum(float t) {
  // 안쪽(보라) → 바깥쪽(분홍/빨강) 7색 동화풍 파스텔 스펙트럼
  vec3 c0 = vec3(0.76, 0.60, 0.98); // 라벤더
  vec3 c1 = vec3(0.56, 0.68, 0.99); // 남색 파스텔
  vec3 c2 = vec3(0.50, 0.88, 0.99); // 하늘
  vec3 c3 = vec3(0.56, 0.94, 0.72); // 민트
  vec3 c4 = vec3(0.99, 0.95, 0.56); // 레몬
  vec3 c5 = vec3(1.00, 0.76, 0.50); // 살구
  vec3 c6 = vec3(0.99, 0.58, 0.66); // 파스텔 코랄 레드
  float x = clamp(t, 0.0, 1.0) * 6.0;
  if (x < 1.0) return mix(c0, c1, x);
  if (x < 2.0) return mix(c1, c2, x - 1.0);
  if (x < 3.0) return mix(c2, c3, x - 2.0);
  if (x < 4.0) return mix(c3, c4, x - 3.0);
  if (x < 5.0) return mix(c4, c5, x - 4.0);
  return mix(c5, c6, x - 5.0);
}

void main() {
  // 픽셀 단위 반경·호각 계산 + 메시 경계 이전 완전 0 페더링으로 에일리어싱/어두운 테두리 0
  float r = length(vLocalPos);
  float r01 = clamp((r - 25.0) / 9.0, 0.0, 1.0);
  float arc01 = clamp(atan(vLocalPos.y, vLocalPos.x) / 3.14159265, 0.0, 1.0);
  float radialFade = smoothstep(0.08, 0.30, r01) * smoothstep(0.92, 0.70, r01);
  float arcFade = smoothstep(0.06, 0.24, arc01) * smoothstep(0.94, 0.76, arc01);
  float shimmer = 0.93 + 0.07 * sin(uTime * 1.4 + arc01 * 12.0);
  float alpha = radialFade * arcFade * uAlpha * 0.48 * shimmer;
  vec3 col = rainbowSpectrum(smoothstep(0.08, 0.92, r01));
  fragColor = vec4(col, alpha);
}
`;

export interface SkyAndLightingRig {
  readonly group: Group;
  readonly sunDir: Vector3;
  readonly avatarWorldTint: Vector3;
  nightFactor: number;
  /** 그림자 카메라·야간 가로등 풀 중심을 플레이어/주시점으로 텍셀 스냅 추적한다. */
  updateShadowFocus(x: number, z: number): void;
  /** 날씨 파티클 모드(`clear` / `sakura` / `rain` / `snow`) 전환. `clear` 시 draw call 0. */
  setWeather(mode: WorldWeatherMode): void;
  /** 길드 회관 너머 하늘에 반투명 7색 파스텔 무지개 아치를 띄운다 (1 draw call). */
  triggerRainbow(durationSec?: number): void;
  update(
    dt: number,
    elapsed: number,
    timeMode: WorldTimeMode,
    playerPos: Vector3,
    commanderPositions: readonly Vector3[],
  ): void;
  setStreetlampAnchors(anchors: readonly Vector3[]): void;
  dispose(): void;
}

let cachedWallHour = 12;
let cachedWallHourAt = -Infinity;

function resolveTargetBlend(mode: WorldTimeMode, elapsed: number): number {
  if (mode === "day") return 0.0;
  if (mode === "sunset") return 0.5;
  if (mode === "night") return 1.0;
  if (mode === "cycle") return 0.5 - 0.5 * Math.cos(elapsed * 0.24);
  const nowMs = performance.now();
  if (nowMs - cachedWallHourAt > 10_000) {
    const now = new Date();
    cachedWallHour = now.getHours() + now.getMinutes() / 60;
    cachedWallHourAt = nowMs;
  }
  const hour = cachedWallHour;
  if (hour >= 8 && hour <= 16.5) return 0.0;
  if (hour > 16.5 && hour < 19.5) return ((hour - 16.5) / 3.0) * 0.85;
  if (hour >= 5.5 && hour < 8) return (1 - (hour - 5.5) / 2.5) * 0.85;
  return 1.0;
}

const MAX_NIGHT_LAMP_LIGHTS = 6;
const MAX_ANTENNA_LIGHTS = 4;
const MAX_GOLDEN_FIREFLIES = 96;
const MAX_WEATHER_PARTICLES = 320;
const SHADOW_BOUNDS = 36;
const SHADOW_MAP_SIZE = 2048;
const SHADOW_TEXEL_WORLD = (SHADOW_BOUNDS * 2) / SHADOW_MAP_SIZE;
const SHADOW_SNAP_STEP = SHADOW_TEXEL_WORLD * 4;

export function createSkyAndLighting(scene: Scene): SkyAndLightingRig {
  const group = new Group();
  // 넓은 초원과 원경 산맥이 또렷하게 보이도록 안개 농도를 완만하게 설정
  const fog = new FogExp2(0xd6f0ff, 0.0044);
  scene.fog = fog;

  const uSkyTop = new Color(0x3fa4f8);
  const uSkyHorizon = new Color(0xd8f2ff);
  const sunDir = new Vector3(0.50, 0.84, 0.46).normalize();
  const avatarWorldTint = new Vector3(1.02, 1.01, 0.99);

  const skyGeo = new SphereGeometry(185, 32, 20);
  const skyMat = new ShaderMaterial({
    glslVersion: GLSL3,
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uSkyTop: { value: uSkyTop },
      uSkyHorizon: { value: uSkyHorizon },
      uSunDir: { value: sunDir },
      uNight: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
  });
  const skyMesh = new Mesh(skyGeo, skyMat);
  skyMesh.frustumCulled = false;
  group.add(skyMesh);

  // 주 태양/달 그림자 광원 (주시점 기준 텍셀 스냅 추적으로 260m 전역에서 선명한 그림자 유지)
  const dirLight = new DirectionalLight(0xfff7e4, 1.95);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  dirLight.shadow.camera.near = 2;
  dirLight.shadow.camera.far = 130;
  dirLight.shadow.camera.left = -SHADOW_BOUNDS;
  dirLight.shadow.camera.right = SHADOW_BOUNDS;
  dirLight.shadow.camera.top = SHADOW_BOUNDS;
  dirLight.shadow.camera.bottom = -SHADOW_BOUNDS;
  dirLight.shadow.bias = -0.0005;
  dirLight.shadow.normalBias = 0.025;
  group.add(dirLight);
  group.add(dirLight.target);

  // 반구형 하늘/초원 반사 환경광
  const hemiLight = new HemisphereLight(0xa4d8ff, 0x56a856, 0.92);
  group.add(hemiLight);

  // 광장 모닥불 광원 (2.8, 1.0)
  const campfireLight = new PointLight(0xff8c2b, 3.2, 13.0, 1.6);
  campfireLight.position.set(2.8, 1.35, 1.0);
  group.add(campfireLight);

  // 플레이어 휴대용 랜턴 광원 (주간에는 visible=false로 PBR 셰이더 PointLight 루프에서 제외)
  const playerLantern = new PointLight(0xffe484, 0, 8.5, 1.7);
  playerLantern.visible = false;
  group.add(playerLantern);

  // 야간 근접 가로등 광원 풀 (최대 6개 — 카메라/주시점 기준 가장 가까운 6개만 활성)
  const lampLights = Array.from({ length: MAX_NIGHT_LAMP_LIGHTS }, () => {
    const pl = new PointLight(0xffe074, 0, 10.0, 1.7);
    pl.visible = false;
    group.add(pl);
    return pl;
  });

  // 지휘관 머리 위 안테나 광원 풀 (최대 4개)
  const antennaLights = Array.from({ length: MAX_ANTENNA_LIGHTS }, () => {
    const pl = new PointLight(0xffe866, 0, 6.5, 1.8);
    pl.visible = false;
    group.add(pl);
    return pl;
  });

  // 야간·노을 황금 반딧불이 풀 (단일 InstancedMesh draw call, 주간 visible=false)
  const fireflyGeo = new SphereGeometry(0.058, 6, 5);
  const fireflyMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const fireflyInstanced = new InstancedMesh(fireflyGeo, fireflyMat, MAX_GOLDEN_FIREFLIES);
  fireflyInstanced.instanceMatrix.setUsage(DynamicDrawUsage);
  fireflyInstanced.frustumCulled = false;
  fireflyInstanced.visible = false;

  const ffSeeds = Array.from({ length: MAX_GOLDEN_FIREFLIES }, (_, i) => {
    const goldenAng = i * 2.3999632297;
    const rad = 7.5 + Math.sqrt((i + 0.5) / MAX_GOLDEN_FIREFLIES) * 54.0;
    const baseX = Math.cos(goldenAng) * rad;
    const baseZ = Math.sin(goldenAng) * rad;
    const baseY = 0.65 + ((i * 37) % 100) * 0.028;
    const phase = i * 1.73;
    const speed = 0.45 + ((i * 19) % 10) * 0.06;
    const blinkSpeed = 1.6 + ((i * 23) % 11) * 0.22;
    const driftR = 0.9 + ((i * 13) % 7) * 0.25;
    return { baseX, baseZ, baseY, phase, speed, blinkSpeed, driftR };
  });

  const ffMat4 = new Matrix4();
  const ffPos = new Vector3();
  const ffQuat = new Quaternion();
  const ffScale = new Vector3();
  const ffPalette = [0xffe066, 0xffc247, 0xfef08a, 0xffd166] as const;
  const ffColor = new Color();
  for (let i = 0; i < MAX_GOLDEN_FIREFLIES; i += 1) {
    ffColor.setHex(ffPalette[i % ffPalette.length]!).multiplyScalar(1.48);
    fireflyInstanced.setColorAt(i, ffColor);
  }
  if (fireflyInstanced.instanceColor) fireflyInstanced.instanceColor.needsUpdate = true;
  group.add(fireflyInstanced);

  // 날씨 파티클 풀 (단일 InstancedMesh 320기 — sakura/rain/snow 공용, clear 시 visible=false로 비용 0)
  const weatherGeo = new OctahedronGeometry(0.5, 0);
  const weatherMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
  });
  const weatherInstanced = new InstancedMesh(weatherGeo, weatherMat, MAX_WEATHER_PARTICLES);
  weatherInstanced.instanceMatrix.setUsage(DynamicDrawUsage);
  weatherInstanced.frustumCulled = false;
  weatherInstanced.visible = false;
  group.add(weatherInstanced);

  const weatherSeeds = Array.from({ length: MAX_WEATHER_PARTICLES }, (_, i) => ({
    ox: (((i * 73) % 1000) / 1000 - 0.5) * 54,
    oy: (((i * 41) % 1000) / 1000) * 22,
    oz: (((i * 97) % 1000) / 1000 - 0.5) * 54,
    phase: i * 1.37,
    speed: 0.78 + ((i * 29) % 10) * 0.055,
    sway: 0.55 + ((i * 17) % 8) * 0.12,
    size: 0.8 + ((i * 13) % 7) * 0.08,
  }));

  const wMat4 = new Matrix4();
  const wPos = new Vector3();
  const wEuler = new Euler();
  const wQuat = new Quaternion();
  const wScale = new Vector3();
  const wColor = new Color();
  let currentWeather: WorldWeatherMode = "clear";

  const applyWeatherPalette = (mode: WorldWeatherMode) => {
    if (mode === "clear") return;
    const sakuraCols = [0xffb7d5, 0xffd1e6, 0xffe4f0, 0xf9a8d4] as const;
    const rainCols = [0xbfe3ff, 0x93c5fd, 0xdbeafe, 0xa5d8ff] as const;
    const snowCols = [0xffffff, 0xf0f9ff, 0xe0f2fe, 0xf8fafc] as const;
    const palette = mode === "sakura" ? sakuraCols : mode === "rain" ? rainCols : snowCols;
    weatherMat.opacity = mode === "rain" ? 0.62 : mode === "sakura" ? 0.90 : 0.92;
    for (let i = 0; i < MAX_WEATHER_PARTICLES; i += 1) {
      wColor.setHex(palette[i % palette.length]!);
      weatherInstanced.setColorAt(i, wColor);
    }
    if (weatherInstanced.instanceColor) weatherInstanced.instanceColor.needsUpdate = true;
  };

  // 길드 회관 너머 하늘 3D 파스텔 무지개 아치 (1 draw call, 비활성 시 visible=false)
  const rainbowGeo = new RingGeometry(25, 34, 64, 1, 0, Math.PI);
  const rainbowMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uAlpha: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: RAINBOW_VERTEX,
    fragmentShader: RAINBOW_FRAGMENT,
  });
  const rainbowMesh = new Mesh(rainbowGeo, rainbowMat);
  rainbowMesh.position.set(0, -2.5, -34);
  rainbowMesh.rotation.y = 0.06;
  rainbowMesh.renderOrder = 1;
  rainbowMesh.visible = false;
  group.add(rainbowMesh);

  let rainbowAge = 0;
  let rainbowDuration = 0;

  scene.add(group);

  let shadowFocusX = 0;
  let shadowFocusZ = 0;
  let allLampAnchors: readonly Vector3[] = [];
  let lampsDirty = true;
  let lastLampSelectX = Number.NaN;
  let lastLampSelectZ = Number.NaN;
  const activeLampCount = { value: 0 };
  const topLampIdx = new Int32Array(MAX_NIGHT_LAMP_LIGHTS);
  const topLampDist2 = new Float64Array(MAX_NIGHT_LAMP_LIGHTS);

  function selectNearestLamps(cx: number, cz: number): void {
    const n = allLampAnchors.length;
    const k = Math.min(n, MAX_NIGHT_LAMP_LIGHTS);
    topLampDist2.fill(Infinity);
    topLampIdx.fill(-1);

    for (let i = 0; i < n; i += 1) {
      const a = allLampAnchors[i]!;
      const dx = a.x - cx;
      const dz = a.z - cz;
      const d2 = dx * dx + dz * dz;
      // 최대값 슬롯과 비교해 상위 k개 유지 (할당 0)
      if (d2 >= topLampDist2[k - 1]!) continue;
      let pos = k - 1;
      while (pos > 0 && d2 < topLampDist2[pos - 1]!) {
        topLampDist2[pos] = topLampDist2[pos - 1]!;
        topLampIdx[pos] = topLampIdx[pos - 1]!;
        pos -= 1;
      }
      topLampDist2[pos] = d2;
      topLampIdx[pos] = i;
    }

    activeLampCount.value = k;
    for (let i = 0; i < MAX_NIGHT_LAMP_LIGHTS; i += 1) {
      const pl = lampLights[i]!;
      const idx = i < k ? topLampIdx[i]! : -1;
      const anchor = idx >= 0 ? allLampAnchors[idx] : undefined;
      if (anchor) {
        pl.position.set(anchor.x, anchor.y + 1.85, anchor.z);
      } else {
        pl.position.set(0, -50, 0);
      }
    }
    lastLampSelectX = cx;
    lastLampSelectZ = cz;
    lampsDirty = false;
  }

  let blend = 0.0;
  const cDayTop = new Color(0x3fa4f8);
  const cSunsetTop = new Color(0x47307a);
  const cNightTop = new Color(0x0b132e);

  const cDayHor = new Color(0xd8f2ff);
  const cSunsetHor = new Color(0xfd9460);
  const cNightHor = new Color(0x1a2850);

  const cDaySun = new Color(0xfff7e4);
  const cSunsetSun = new Color(0xff8e4f);
  const cNightMoon = new Color(0x5b7cc0);

  const cDaySkyAmb = new Color(0xa4d8ff);
  const cSunsetSkyAmb = new Color(0x9b6e96);
  const cNightSkyAmb = new Color(0x2f4375);

  const cDayGndAmb = new Color(0x58a856);
  const cSunsetGndAmb = new Color(0x594246);
  const cNightGndAmb = new Color(0x182438);

  const vDayDir = new Vector3(0.50, 0.84, 0.46).normalize();
  const vSunsetDir = new Vector3(0.84, 0.28, 0.36).normalize();
  const vNightDir = new Vector3(-0.46, 0.72, -0.46).normalize();

  const rig: SkyAndLightingRig = {
    group,
    sunDir,
    avatarWorldTint,
    nightFactor: 0,
    updateShadowFocus(x, z) {
      shadowFocusX = Math.round(x / SHADOW_SNAP_STEP) * SHADOW_SNAP_STEP;
      shadowFocusZ = Math.round(z / SHADOW_SNAP_STEP) * SHADOW_SNAP_STEP;
    },
    setStreetlampAnchors(anchors) {
      allLampAnchors = anchors;
      lampsDirty = true;
    },
    setWeather(mode) {
      const prev = currentWeather;
      currentWeather = mode;
      weatherInstanced.visible = mode !== "clear";
      if (mode !== "clear") {
        applyWeatherPalette(mode);
      } else if (prev === "rain") {
        // 비가 맑게 개면 하늘에 깜짝 파스텔 무지개 선물!
        rainbowAge = 0;
        rainbowDuration = 18;
      }
    },
    triggerRainbow(durationSec = 16) {
      rainbowAge = 0;
      rainbowDuration = Math.max(4, durationSec);
    },
    update(dt, elapsed, timeMode, playerPos, commanderPositions) {
      const target = resolveTargetBlend(timeMode, elapsed);
      blend += (target - blend) * Math.min(1, dt * 3.0);

      let night = 0;
      if (blend <= 0.5) {
        const k = blend * 2;
        uSkyTop.copy(cDayTop).lerp(cSunsetTop, k);
        uSkyHorizon.copy(cDayHor).lerp(cSunsetHor, k);
        dirLight.color.copy(cDaySun).lerp(cSunsetSun, k);
        dirLight.intensity = 1.95 - k * 0.50;
        hemiLight.color.copy(cDaySkyAmb).lerp(cSunsetSkyAmb, k);
        hemiLight.groundColor.copy(cDayGndAmb).lerp(cSunsetGndAmb, k);
        hemiLight.intensity = 0.92 - k * 0.14;
        sunDir.copy(vDayDir).lerp(vSunsetDir, k).normalize();
        avatarWorldTint.set(1.01, 1.00 - k * 0.12, 0.98 - k * 0.18);
        night = k * 0.38;
      } else {
        const k = (blend - 0.5) * 2;
        uSkyTop.copy(cSunsetTop).lerp(cNightTop, k);
        uSkyHorizon.copy(cSunsetHor).lerp(cNightHor, k);
        dirLight.color.copy(cSunsetSun).lerp(cNightMoon, k);
        dirLight.intensity = 1.45 - k * 0.68;
        hemiLight.color.copy(cSunsetSkyAmb).lerp(cNightSkyAmb, k);
        hemiLight.groundColor.copy(cSunsetGndAmb).lerp(cNightGndAmb, k);
        hemiLight.intensity = 0.78 - k * 0.20;
        sunDir.copy(vSunsetDir).lerp(vNightDir, k).normalize();
        avatarWorldTint.set(1.01 - k * 0.28, 0.88 - k * 0.10, 0.80 + k * 0.18);
        night = 0.38 + k * 0.62;
      }

      rig.nightFactor = night;
      dirLight.target.position.set(shadowFocusX, 0, shadowFocusZ);
      dirLight.target.updateMatrixWorld();
      dirLight.position.set(
        shadowFocusX + sunDir.x * 52,
        sunDir.y * 52,
        shadowFocusZ + sunDir.z * 52,
      );
      fog.color.copy(uSkyHorizon);
      skyMat.uniforms["uNight"]!.value = night;
      skyMat.uniforms["uTime"]!.value = elapsed;

      const lampStrength = Math.max(0, (night - 0.22) / 0.78);
      campfireLight.intensity = (1.5 + lampStrength * 3.0) + Math.sin(elapsed * 12) * 0.32;

      const nightLightsActive = lampStrength > 0.02;
      playerLantern.visible = nightLightsActive;
      if (nightLightsActive) {
        playerLantern.position.set(playerPos.x, playerPos.y + 1.15, playerPos.z);
        playerLantern.intensity = lampStrength * 1.75;

        const focusX = shadowFocusX || playerPos.x;
        const focusZ = shadowFocusZ || playerPos.z;
        if (
          lampsDirty
          || Number.isNaN(lastLampSelectX)
          || Math.hypot(focusX - lastLampSelectX, focusZ - lastLampSelectZ) > 2.0
        ) {
          selectNearestLamps(focusX, focusZ);
        }
        for (let i = 0; i < MAX_NIGHT_LAMP_LIGHTS; i += 1) {
          const pl = lampLights[i]!;
          const active = i < activeLampCount.value && pl.position.y > -10;
          pl.visible = active;
          pl.intensity = active ? lampStrength * (i < 3 ? 2.3 : 1.9) : 0;
        }
      } else {
        playerLantern.intensity = 0;
        for (let i = 0; i < MAX_NIGHT_LAMP_LIGHTS; i += 1) {
          const pl = lampLights[i]!;
          pl.visible = false;
          pl.intensity = 0;
        }
      }

      for (let i = 0; i < MAX_ANTENNA_LIGHTS; i += 1) {
        const pl = antennaLights[i]!;
        const cp = commanderPositions[i];
        if (cp && lampStrength > 0.05) {
          pl.visible = true;
          pl.position.set(cp.x, cp.y + 1.45, cp.z);
          pl.intensity = lampStrength * 1.85;
        } else {
          pl.visible = false;
          pl.intensity = 0;
        }
      }

      // 야간·노을 황금 반딧불이 (주간 visible=false로 CPU/GPU 비용 0)
      const fireflyFade = Math.max(0, Math.min(1, (night - 0.22) / 0.42));
      fireflyInstanced.visible = fireflyFade > 0.01;
      if (fireflyInstanced.visible) {
        for (let i = 0; i < MAX_GOLDEN_FIREFLIES; i += 1) {
          const s = ffSeeds[i]!;
          const t = elapsed * s.speed + s.phase;
          const x = s.baseX + Math.sin(t) * s.driftR;
          const z = s.baseZ + Math.cos(t * 0.82 + 0.6) * s.driftR;
          const y = s.baseY + Math.sin(t * 1.45) * 0.42;
          const pulse = 0.22 + 0.78 * Math.pow(0.5 + 0.5 * Math.sin(elapsed * s.blinkSpeed + s.phase * 2.1), 1.6);
          const sc = pulse * fireflyFade;
          ffPos.set(x, y, z);
          ffScale.set(sc, sc, sc);
          ffMat4.compose(ffPos, ffQuat, ffScale);
          fireflyInstanced.setMatrixAt(i, ffMat4);
        }
        fireflyInstanced.instanceMatrix.needsUpdate = true;
      }

      // 날씨 파티클 갱신 (단일 InstancedMesh 320기, clear 시 0 비용)
      if (currentWeather !== "clear") {
        weatherInstanced.visible = true;
        const wrapSpan = 54;
        const halfSpan = 27;
        const heightSpan = 22;
        const cx = playerPos.x;
        const cz = playerPos.z;

        for (let i = 0; i < MAX_WEATHER_PARTICLES; i += 1) {
          const s = weatherSeeds[i]!;
          let wx: number;
          let wy: number;
          let wz: number;
          if (currentWeather === "rain") {
            const fall = elapsed * 18.5 * s.speed;
            wy = ((s.oy - fall) % heightSpan + heightSpan) % heightSpan + 0.35;
            wx = cx + ((((s.ox + elapsed * 2.6 * s.speed) % wrapSpan) + wrapSpan + halfSpan) % wrapSpan) - halfSpan;
            wz = cz + ((((s.oz + elapsed * 0.9 * s.speed) % wrapSpan) + wrapSpan + halfSpan) % wrapSpan) - halfSpan;
            wEuler.set(0.05, 0, -0.14);
            wQuat.setFromEuler(wEuler);
            wScale.set(0.024 * s.size, 0.95 * s.size, 0.024 * s.size);
          } else if (currentWeather === "sakura") {
            const fall = elapsed * 1.45 * s.speed;
            wy = ((s.oy - fall) % heightSpan + heightSpan) % heightSpan + 0.25;
            const driftX = s.ox + elapsed * 1.35 * s.speed + Math.sin(elapsed * 1.6 + s.phase) * s.sway;
            const driftZ = s.oz + elapsed * 0.65 * s.speed + Math.cos(elapsed * 1.3 + s.phase) * s.sway;
            wx = cx + (((driftX % wrapSpan) + wrapSpan + halfSpan) % wrapSpan) - halfSpan;
            wz = cz + (((driftZ % wrapSpan) + wrapSpan + halfSpan) % wrapSpan) - halfSpan;
            wEuler.set(
              elapsed * 1.9 * s.speed + s.phase,
              elapsed * 1.4 + s.phase * 0.7,
              Math.sin(elapsed * 2.2 + s.phase) * 0.9,
            );
            wQuat.setFromEuler(wEuler);
            wScale.set(0.145 * s.size, 0.032 * s.size, 0.095 * s.size);
          } else {
            // snow
            const fall = elapsed * 2.25 * s.speed;
            wy = ((s.oy - fall) % heightSpan + heightSpan) % heightSpan + 0.25;
            const driftX = s.ox + Math.sin(elapsed * 0.95 + s.phase) * (s.sway * 1.15);
            const driftZ = s.oz + Math.cos(elapsed * 0.85 + s.phase * 1.3) * (s.sway * 1.15);
            wx = cx + (((driftX % wrapSpan) + wrapSpan + halfSpan) % wrapSpan) - halfSpan;
            wz = cz + (((driftZ % wrapSpan) + wrapSpan + halfSpan) % wrapSpan) - halfSpan;
            wEuler.set(elapsed * 0.7 + s.phase, elapsed * 0.9, 0);
            wQuat.setFromEuler(wEuler);
            wScale.set(0.105 * s.size, 0.105 * s.size, 0.105 * s.size);
          }
          wPos.set(wx, wy, wz);
          wMat4.compose(wPos, wQuat, wScale);
          weatherInstanced.setMatrixAt(i, wMat4);
        }
        weatherInstanced.instanceMatrix.needsUpdate = true;
      }

      // 3D 파스텔 무지개 아치 페이드 인/아웃 갱신
      if (rainbowDuration > 0) {
        rainbowAge += dt;
        if (rainbowAge >= rainbowDuration) {
          rainbowDuration = 0;
          rainbowMesh.visible = false;
          rainbowMat.uniforms["uAlpha"]!.value = 0;
        } else {
          const fadeIn = Math.min(1, rainbowAge / 1.4);
          const fadeOut = Math.min(1, (rainbowDuration - rainbowAge) / 2.2);
          const alpha = Math.min(fadeIn, fadeOut) * (1.0 - night * 0.45);
          rainbowMesh.visible = alpha > 0.01;
          rainbowMat.uniforms["uAlpha"]!.value = alpha;
          rainbowMat.uniforms["uTime"]!.value = elapsed;
        }
      }
    },
    dispose() {
      skyGeo.dispose();
      skyMat.dispose();
      fireflyInstanced.dispose();
      fireflyGeo.dispose();
      fireflyMat.dispose();
      weatherInstanced.dispose();
      weatherGeo.dispose();
      weatherMat.dispose();
      rainbowGeo.dispose();
      rainbowMat.dispose();
      scene.remove(group);
    },
  };

  return rig;
}
