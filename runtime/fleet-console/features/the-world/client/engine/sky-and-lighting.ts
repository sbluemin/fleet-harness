import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
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
  PlaneGeometry,
  PointLight,
  Points,
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
    vec3 farNight = mix(vec3(0.042, 0.068, 0.135), uSkyHorizon, 0.58);
    vec3 cFar = mix(mix(farDay, farSet, sunset), farNight, smoothstep(0.42, 0.92, uNight));
    // 최원경 봉우리 정상에 은은한 설산 햇살 림 (야간에는 완전 소거해 지평선 밝은 띠 방지)
    float ridgeSnow = smoothstep(hFar - 0.018, hFar - 0.002, dir.y) * (1.0 - smoothstep(0.25, 0.85, uNight));
    cFar = mix(cFar, vec3(0.95, 0.97, 1.0), ridgeSnow * 0.22);

    vec3 midDay = mix(vec3(0.39, 0.64, 0.78), uSkyHorizon, 0.36);
    vec3 midSet = mix(vec3(0.49, 0.35, 0.52), uSkyHorizon, 0.34);
    vec3 midNight = mix(vec3(0.028, 0.046, 0.095), uSkyHorizon, 0.40);
    vec3 cMid = mix(mix(midDay, midSet, sunset), midNight, smoothstep(0.42, 0.92, uNight));

    vec3 nearDay = mix(vec3(0.31, 0.58, 0.58), uSkyHorizon, 0.18);
    vec3 nearSet = mix(vec3(0.36, 0.26, 0.38), uSkyHorizon, 0.20);
    vec3 nearNight = mix(vec3(0.018, 0.030, 0.065), uSkyHorizon, 0.24);
    vec3 cNear = mix(mix(nearDay, nearSet, sunset), nearNight, smoothstep(0.42, 0.92, uNight));

    // 산기슭 대기 원근 안개 그라데이션 (야간엔 근경 3D 능선과 자연스럽게 이어지도록 부드럽게 블렌딩)
    float nightBlendBoost = smoothstep(0.45, 0.95, uNight) * 0.18;
    float baseMistFar = smoothstep(0.08, -0.01, dir.y) * (0.55 + nightBlendBoost);
    float baseMistMid = smoothstep(0.055, -0.01, dir.y) * (0.45 + nightBlendBoost);
    float baseMistNear = smoothstep(0.025, -0.02, dir.y) * (0.42 + nightBlendBoost * 0.65);

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
  float r01 = clamp((r - 42.0) / 14.0, 0.0, 1.0);
  float arc01 = clamp(atan(vLocalPos.y, vLocalPos.x) / 3.14159265, 0.0, 1.0);
  float radialFade = smoothstep(0.08, 0.30, r01) * smoothstep(0.92, 0.70, r01);
  float arcFade = smoothstep(0.06, 0.24, arc01) * smoothstep(0.94, 0.76, arc01);
  float shimmer = 0.93 + 0.07 * sin(uTime * 1.4 + arc01 * 12.0);
  float alpha = radialFade * arcFade * uAlpha * 0.48 * shimmer;
  vec3 col = rainbowSpectrum(smoothstep(0.08, 0.92, r01));
  fragColor = vec4(col, alpha);
}
`;

const FIREFLY_POINTS_VERTEX = /* glsl */ `
in vec4 aSeed;   // x=phase, y=speed, z=blinkSpeed, w=driftR
in vec3 aColor;
uniform float uTime;
uniform float uFade;
out vec3 vColor;
out float vGlow;

void main() {
  float t = uTime * aSeed.y + aSeed.x;
  vec3 pos = position;
  pos.x += sin(t) * aSeed.w;
  pos.z += cos(t * 0.82 + 0.6) * aSeed.w;
  pos.y += sin(t * 1.45) * 0.42;

  float blink = 0.22 + 0.78 * pow(0.5 + 0.5 * sin(uTime * aSeed.z + aSeed.x * 2.1), 1.6);
  vGlow = blink * uFade;
  vColor = aColor;

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;
  float dist = max(3.0, -mvPos.z);
  gl_PointSize = clamp((155.0 / dist) * (0.65 + 0.55 * blink), 2.5, 18.0);
}
`;

const FIREFLY_POINTS_FRAGMENT = /* glsl */ `
in vec3 vColor;
in float vGlow;
out vec4 fragColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float core = pow(clamp(1.0 - r, 0.0, 1.0), 3.0);
  float halo = pow(clamp(1.0 - r, 0.0, 1.0), 1.45) * 0.62;
  float alpha = (core + halo) * vGlow;
  if (alpha < 0.006) discard;
  vec3 col = mix(vColor, vec3(1.0, 0.99, 0.86), core * 0.75);
  fragColor = vec4(col * 1.35, clamp(alpha, 0.0, 1.0));
}
`;

const SKY_METEOR_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_METEOR_FRAGMENT = /* glsl */ `
uniform float uAlpha;
in vec2 vUv;
out vec4 fragColor;

void main() {
  // vUv.x: 0 = tail, 1 = bright leading head
  float crossDist = abs(vUv.y * 2.0 - 1.0);
  float core = pow(clamp(1.0 - crossDist, 0.0, 1.0), 2.4);
  float tail = pow(clamp(vUv.x, 0.0, 1.0), 2.2) * smoothstep(1.0, 0.92, vUv.x);
  float headGlow = exp(-pow((vUv.x - 0.94) * 14.0, 2.0)) * core;
  float a = (tail * core * 0.85 + headGlow * 1.25) * uAlpha;
  if (a < 0.004) discard;
  vec3 col = mix(vec3(0.68, 0.82, 1.0), vec3(1.0, 0.96, 0.80), smoothstep(0.35, 0.95, vUv.x));
  fragColor = vec4(col * 1.45, clamp(a, 0.0, 1.0));
}
`;

const AURORA_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const AURORA_FRAGMENT = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;

uniform float uTime;
uniform float uAlpha;

void main() {
  float u = vUv.x;
  float v = vUv.y;

  // 2중 물결치는 오로라 커튼 수직 광선 + 수평 파동
  float wave1 = sin(u * 9.5 + uTime * 0.34) * 0.085 + cos(u * 17.0 - uTime * 0.24) * 0.045;
  float wave2 = sin(u * 14.0 - uTime * 0.42 + 1.7) * 0.070 + cos(u * 23.0 + uTime * 0.28) * 0.032;

  float y1 = clamp(v + wave1, 0.0, 1.0);
  float y2 = clamp(v + wave2 - 0.10, 0.0, 1.0);

  float rays1 = 0.55 + 0.45 * sin(u * 44.0 + sin(u * 11.0 + uTime * 0.48) * 2.8 + uTime * 0.65);
  float rays2 = 0.50 + 0.50 * sin(u * 68.0 - sin(u * 15.0 - uTime * 0.38) * 2.4 - uTime * 0.52);
  float fineStreaks = 0.72 + 0.28 * sin(u * 125.0 + uTime * 0.9);

  float band1 = smoothstep(0.04, 0.22, y1) * smoothstep(0.96, 0.24, y1) * pow(rays1, 1.35);
  float band2 = smoothstep(0.06, 0.26, y2) * smoothstep(0.94, 0.30, y2) * pow(rays2, 1.55) * 0.72;
  float edgeFade = smoothstep(0.0, 0.16, u) * smoothstep(1.0, 0.84, u);

  float intensity = (band1 + band2) * fineStreaks * edgeFade;
  float alpha = intensity * uAlpha * 0.66;
  if (alpha < 0.004) discard;

  // 에메랄드 그린(하단 발광) → 루미너스 시안(중단) → 보라/라벤더(상단 너울)
  vec3 cEmerald = vec3(0.14, 0.96, 0.58);
  vec3 cCyan = vec3(0.18, 0.82, 0.98);
  vec3 cViolet = vec3(0.64, 0.30, 0.96);
  vec3 col1 = mix(cEmerald, cCyan, smoothstep(0.12, 0.52, y1));
  col1 = mix(col1, cViolet, smoothstep(0.46, 0.88, y1));
  vec3 col2 = mix(cCyan, cViolet, smoothstep(0.16, 0.82, y2));
  vec3 col = mix(col1, col2, band2 / max(0.001, band1 + band2));
  // 하단 커튼 엣지 밝은 에메랄드-골드 코어 리프트
  float lowerCore = smoothstep(0.28, 0.08, y1) * smoothstep(0.03, 0.14, y1) * rays1;
  col += vec3(0.32, 0.98, 0.72) * lowerCore * 0.45;

  fragColor = vec4(col * 1.25, clamp(alpha, 0.0, 0.85));
}
`;

export interface SkyAndLightingRig {
  readonly group: Group;
  readonly sunDir: Vector3;
  readonly avatarWorldTint: Vector3;
  nightFactor: number;
  /** 현재 밤 가중치(`0` 한낮 .. `1` 깊은 별밤)를 반환한다. */
  getNightFactor(): number;
  /** 밤하늘 GLSL3 오로라 커튼 표시 여부를 전환한다 (기본 true, 주간 Draw Call 0). */
  setAuroraEnabled(enabled: boolean): void;
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

function smoothstep01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function resolveTargetBlend(mode: WorldTimeMode, elapsed: number): number {
  if (mode === "day") return 0.0;
  if (mode === "sunset") return 0.5;
  if (mode === "night") return 1.0;
  if (mode === "cycle") return 0.5 - 0.5 * Math.cos(elapsed * 0.24);
  // realtime: 실제 로컬 시계(new Date) 기준으로 새벽·아침·낮·지브리 노을·별밤을 부드럽게 보간
  const nowMs = performance.now();
  if (nowMs - cachedWallHourAt > 10_000) {
    const now = new Date();
    cachedWallHour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
    cachedWallHourAt = nowMs;
  }
  const hour = cachedWallHour;
  if (hour >= 8.5 && hour <= 16.5) return 0.0;
  if (hour > 16.5 && hour < 18.5) return smoothstep01((hour - 16.5) / 2.0) * 0.5;
  if (hour >= 18.5 && hour < 20.5) return 0.5 + smoothstep01((hour - 18.5) / 2.0) * 0.5;
  if (hour >= 5.0 && hour < 6.5) return 1.0 - smoothstep01((hour - 5.0) / 1.5) * 0.5;
  if (hour >= 6.5 && hour < 8.5) return 0.5 * (1.0 - smoothstep01((hour - 6.5) / 2.0));
  return 1.0;
}

const MAX_NIGHT_LAMP_LIGHTS = 6;
const MAX_ANTENNA_LIGHTS = 4;
const MAX_GOLDEN_FIREFLIES = 128;
const MAX_SKY_METEORS = 3;
const MAX_WEATHER_PARTICLES = 360;
const SHADOW_BOUNDS = 95;
const SHADOW_MAP_SIZE = 2048;
const SHADOW_TEXEL_WORLD = (SHADOW_BOUNDS * 2) / SHADOW_MAP_SIZE;
const SHADOW_SNAP_STEP = SHADOW_TEXEL_WORLD * 4;

export function createSkyAndLighting(scene: Scene): SkyAndLightingRig {
  const group = new Group();
  // 확장된 380m 지형·88m 초원 마을과 원경 산맥이 또렷하게 보이도록 대기 안개 농도를 여유 있게 튜닝
  const fog = new FogExp2(0xd6f0ff, 0.0026);
  scene.fog = fog;

  const uSkyTop = new Color(0x3fa4f8);
  const uSkyHorizon = new Color(0xd8f2ff);
  const sunDir = new Vector3(0.50, 0.84, 0.46).normalize();
  const avatarWorldTint = new Vector3(1.02, 1.01, 0.99);

  const skyGeo = new SphereGeometry(340, 32, 20);
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

  // 주 태양/달 그림자 광원 (±95m 절두체 · 텍셀 스냅 추적으로 380m 확장 맵 외곽 마을까지 선명한 그림자 유지)
  const dirLight = new DirectionalLight(0xfff7e4, 1.95);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  dirLight.shadow.camera.near = 2;
  dirLight.shadow.camera.far = 260;
  dirLight.shadow.camera.left = -SHADOW_BOUNDS;
  dirLight.shadow.camera.right = SHADOW_BOUNDS;
  dirLight.shadow.camera.top = SHADOW_BOUNDS;
  dirLight.shadow.camera.bottom = -SHADOW_BOUNDS;
  dirLight.shadow.bias = -0.0005;
  dirLight.shadow.normalBias = 0.032;
  group.add(dirLight);
  group.add(dirLight.target);

  // 반구형 하늘/초원 반사 환경광
  const hemiLight = new HemisphereLight(0xa4d8ff, 0x56a856, 0.92);
  group.add(hemiLight);

  // 광장 모닥불 광원 (2.8, 1.0) — 야간에 따뜻한 호박빛 대비 극대화
  const campfireLight = new PointLight(0xff8424, 3.2, 15.5, 1.55);
  campfireLight.position.set(2.8, 1.28, 1.0);
  group.add(campfireLight);

  // 플레이어 휴대용 랜턴 광원 (주간에는 visible=false로 PBR 셰이더 PointLight 루프에서 제외)
  const playerLantern = new PointLight(0xffe07d, 0, 9.2, 1.65);
  playerLantern.visible = false;
  group.add(playerLantern);

  // 야간 근접 가로등 광원 풀 (최대 6개 — 카메라/주시점 기준 가장 가까운 6개만 활성)
  const lampLights = Array.from({ length: MAX_NIGHT_LAMP_LIGHTS }, () => {
    const pl = new PointLight(0xffd764, 0, 11.5, 1.65);
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

  // 야간·노을 황금-연두 반딧불이 (`THREE.Points` GPU 포인트 셰이더 128기, 88m 확장 초원·강가·숲 전역, 주간 visible=false)
  const ffPositions = new Float32Array(MAX_GOLDEN_FIREFLIES * 3);
  const ffSeedsAttr = new Float32Array(MAX_GOLDEN_FIREFLIES * 4);
  const ffColors = new Float32Array(MAX_GOLDEN_FIREFLIES * 3);
  const ffPalette = [0xffe066, 0xd9f99d, 0xfef08a, 0xbef264, 0xffd166] as const;
  const ffColor = new Color();
  for (let i = 0; i < MAX_GOLDEN_FIREFLIES; i += 1) {
    let baseX: number;
    let baseZ: number;
    if (i < 44) {
      // 확장된 시냇물 강가 주변 44기 (|x| <= 80)
      const tStream = (i / 43) * 2 - 1;
      baseX = tStream * 80 + Math.sin(i * 4.3) * 2.4;
      const brookZ = 9.2 + Math.sin(baseX * 0.095) * 2.9 + Math.cos(baseX * 0.04) * 1.1;
      baseZ = brookZ + ((i % 2 === 0 ? 1 : -1) * (2.4 + (i % 5) * 0.85));
    } else {
      // 소나무 숲 · 외곽 마을 가장자리 84기 (반경 14..86m)
      const idx = i - 44;
      const goldenAng = idx * 2.3999632297;
      const rad = 14.0 + Math.sqrt((idx + 0.5) / (MAX_GOLDEN_FIREFLIES - 44)) * 72.0;
      baseX = Math.cos(goldenAng) * rad;
      baseZ = Math.sin(goldenAng) * rad;
    }
    const baseY = 0.72 + ((i * 37) % 100) * 0.026;
    ffPositions[i * 3 + 0] = baseX;
    ffPositions[i * 3 + 1] = baseY;
    ffPositions[i * 3 + 2] = baseZ;

    ffSeedsAttr[i * 4 + 0] = i * 1.73; // phase
    ffSeedsAttr[i * 4 + 1] = 0.45 + ((i * 19) % 10) * 0.06; // speed
    ffSeedsAttr[i * 4 + 2] = 1.55 + ((i * 23) % 11) * 0.22; // blinkSpeed
    ffSeedsAttr[i * 4 + 3] = 0.95 + ((i * 13) % 7) * 0.28; // driftR

    ffColor.setHex(ffPalette[i % ffPalette.length]!);
    ffColors[i * 3 + 0] = ffColor.r;
    ffColors[i * 3 + 1] = ffColor.g;
    ffColors[i * 3 + 2] = ffColor.b;
  }
  const fireflyGeo = new BufferGeometry();
  fireflyGeo.setAttribute("position", new BufferAttribute(ffPositions, 3));
  fireflyGeo.setAttribute("aSeed", new BufferAttribute(ffSeedsAttr, 4));
  fireflyGeo.setAttribute("aColor", new BufferAttribute(ffColors, 3));
  const fireflyMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 0 },
    },
    vertexShader: FIREFLY_POINTS_VERTEX,
    fragmentShader: FIREFLY_POINTS_FRAGMENT,
  });
  const fireflyPoints = new Points(fireflyGeo, fireflyMat);
  fireflyPoints.frustumCulled = false;
  fireflyPoints.renderOrder = 3;
  fireflyPoints.visible = false;
  group.add(fireflyPoints);

  // 배경 밤하늘 유성우 풀 (3기 풀링된 스트릭 메시, 주간·비활성 시 visible=false → Draw Call +0)
  const meteorGeo = new PlaneGeometry(24.0, 0.85);
  interface SkyMeteorSlot {
    readonly mesh: Mesh;
    readonly mat: ShaderMaterial;
    active: boolean;
    age: number;
    duration: number;
    startPos: Vector3;
    endPos: Vector3;
    dir: Vector3;
    side: Vector3;
  }
  const meteorSlots: SkyMeteorSlot[] = Array.from({ length: MAX_SKY_METEORS }, () => {
    const mat = new ShaderMaterial({
      glslVersion: GLSL3,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      uniforms: { uAlpha: { value: 0 } },
      vertexShader: SKY_METEOR_VERTEX,
      fragmentShader: SKY_METEOR_FRAGMENT,
    });
    const mesh = new Mesh(meteorGeo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.visible = false;
    group.add(mesh);
    return {
      mesh,
      mat,
      active: false,
      age: 0,
      duration: 1.4,
      startPos: new Vector3(),
      endPos: new Vector3(),
      dir: new Vector3(),
      side: new Vector3(),
    };
  });
  const meteorScratchPos = new Vector3();
  const meteorScratchBasis = new Matrix4();
  const meteorScratchNormal = new Vector3();
  let nextMeteorCooldown = 3.5;

  function spawnSkyMeteor(): void {
    const slot = meteorSlots.find((s) => !s.active);
    if (!slot) return;
    const az = Math.random() * Math.PI * 2;
    const elev = 0.44 + Math.random() * 0.42; // 25°..50° 밤하늘 고도
    const domeR = 265;
    const cx = Math.cos(az) * Math.cos(elev) * domeR;
    const cy = Math.sin(elev) * domeR;
    const cz = Math.sin(az) * Math.cos(elev) * domeR;
    // 접선 + 하강 대각선 궤적 (길이 ~72..102m)
    const tangX = -Math.sin(az);
    const tangZ = Math.cos(az);
    const sign = Math.random() < 0.5 ? 1 : -1;
    slot.dir.set(tangX * sign * 0.84, -0.46, tangZ * sign * 0.84).normalize();
    const span = 72 + Math.random() * 30;
    slot.startPos.set(cx - slot.dir.x * span * 0.5, cy - slot.dir.y * span * 0.5, cz - slot.dir.z * span * 0.5);
    slot.endPos.set(cx + slot.dir.x * span * 0.5, cy + slot.dir.y * span * 0.5, cz + slot.dir.z * span * 0.5);
    slot.age = 0;
    slot.duration = 1.15 + Math.random() * 0.55;
    slot.active = true;
    slot.mesh.visible = true;
  }

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
    ox: (((i * 73) % 1000) / 1000 - 0.5) * 72,
    oy: (((i * 41) % 1000) / 1000) * 28,
    oz: (((i * 97) % 1000) / 1000 - 0.5) * 72,
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

  // 북쪽 외곽 마을 너머 하늘 3D 파스텔 무지개 아치 (1 draw call, 비활성 시 visible=false)
  const rainbowGeo = new RingGeometry(42, 56, 64, 1, 0, Math.PI);
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
  rainbowMesh.position.set(0, -3.0, -76);
  rainbowMesh.rotation.y = 0.06;
  rainbowMesh.renderOrder = 1;
  rainbowMesh.visible = false;
  group.add(rainbowMesh);

  let rainbowAge = 0;
  let rainbowDuration = 0;

  // 밤하늘 북쪽~동서 넓은 방위각 상공(y = 38..130m, 반경 218..234m) 물결치는 GLSL3 오로라 커튼 (지상 산책 중에도 상단 1/3 장관 연출)
  const auroraGeo = new CylinderGeometry(218, 234, 92, 84, 6, true, Math.PI * 0.28, Math.PI * 1.44);
  const auroraMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    fog: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uAlpha: { value: 0 },
    },
    vertexShader: AURORA_VERTEX,
    fragmentShader: AURORA_FRAGMENT,
  });
  const auroraMesh = new Mesh(auroraGeo, auroraMat);
  auroraMesh.position.set(0, 84, 0);
  auroraMesh.frustumCulled = false;
  auroraMesh.renderOrder = 1;
  auroraMesh.visible = false;
  group.add(auroraMesh);

  let auroraEnabled = true;
  let auroraStrength = 0;

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
  const cNightTop = new Color(0x081028);

  const cDayHor = new Color(0xd8f2ff);
  const cSunsetHor = new Color(0xfd9460);
  const cNightHor = new Color(0x142142);

  const cDaySun = new Color(0xfff7e4);
  const cSunsetSun = new Color(0xff8e4f);
  const cNightMoon = new Color(0x6486cc);

  const cDaySkyAmb = new Color(0xa4d8ff);
  const cSunsetSkyAmb = new Color(0x9b6e96);
  const cNightSkyAmb = new Color(0x223663);

  const cDayGndAmb = new Color(0x58a856);
  const cSunsetGndAmb = new Color(0x594246);
  const cNightGndAmb = new Color(0x0f1b2e);

  const vDayDir = new Vector3(0.50, 0.84, 0.46).normalize();
  const vSunsetDir = new Vector3(0.84, 0.28, 0.36).normalize();
  const vNightDir = new Vector3(-0.46, 0.72, -0.46).normalize();

  const rig: SkyAndLightingRig = {
    group,
    sunDir,
    avatarWorldTint,
    nightFactor: 0,
    getNightFactor() {
      return rig.nightFactor;
    },
    setAuroraEnabled(enabled) {
      auroraEnabled = enabled;
    },
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
        dirLight.intensity = 1.45 - k * 0.88;
        hemiLight.color.copy(cSunsetSkyAmb).lerp(cNightSkyAmb, k);
        hemiLight.groundColor.copy(cSunsetGndAmb).lerp(cNightGndAmb, k);
        hemiLight.intensity = 0.78 - k * 0.34;
        sunDir.copy(vSunsetDir).lerp(vNightDir, k).normalize();
        avatarWorldTint.set(1.01 - k * 0.28, 0.88 - k * 0.12, 0.80 + k * 0.18);
        night = 0.38 + k * 0.62;
      }

      rig.nightFactor = night;
      dirLight.target.position.set(shadowFocusX, 0, shadowFocusZ);
      dirLight.target.updateMatrixWorld();
      dirLight.position.set(
        shadowFocusX + sunDir.x * 96,
        sunDir.y * 96,
        shadowFocusZ + sunDir.z * 96,
      );
      fog.color.copy(uSkyHorizon);
      skyMat.uniforms["uNight"]!.value = night;
      skyMat.uniforms["uTime"]!.value = elapsed;

      const lampStrength = Math.max(0, (night - 0.22) / 0.78);
      campfireLight.intensity = (1.8 + lampStrength * 4.2) + Math.sin(elapsed * 11.5) * 0.38 + Math.cos(elapsed * 17.3) * 0.18;

      const nightLightsActive = lampStrength > 0.02;
      playerLantern.visible = nightLightsActive;
      if (nightLightsActive) {
        playerLantern.position.set(playerPos.x, playerPos.y + 1.15, playerPos.z);
        playerLantern.intensity = lampStrength * 1.95;

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
          pl.intensity = active ? lampStrength * (i < 3 ? 2.85 : 2.35) : 0;
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

      // 야간·노을 황금-연두 반딧불이 (`THREE.Points` GPU 셰이더 96기, 주간 visible=false로 CPU/GPU 비용 0)
      const fireflyFade = Math.max(0, Math.min(1, (night - 0.28) / 0.36));
      fireflyPoints.visible = fireflyFade > 0.01;
      if (fireflyPoints.visible) {
        fireflyMat.uniforms["uTime"]!.value = elapsed;
        fireflyMat.uniforms["uFade"]!.value = fireflyFade;
      }

      // 밤하늘 오로라 커튼 갱신 (night > 0.35 && auroraEnabled, 주간·비활성 시 visible=false → Draw Call +0)
      const targetAurora = auroraEnabled && night > 0.35
        ? smoothstep01((night - 0.35) / 0.38)
        : 0;
      auroraStrength += (targetAurora - auroraStrength) * Math.min(1, dt * 2.4);
      auroraMesh.visible = auroraStrength > 0.008;
      if (auroraMesh.visible) {
        auroraMat.uniforms["uTime"]!.value = elapsed;
        auroraMat.uniforms["uAlpha"]!.value = auroraStrength;
      }

      // 배경 밤하늘 유성우 (밤 시간대 10~18초 간격, 3기 풀링 0-GC)
      if (night > 0.35) {
        nextMeteorCooldown -= dt;
        if (nextMeteorCooldown <= 0) {
          spawnSkyMeteor();
          nextMeteorCooldown = 10.0 + Math.random() * 8.0;
        }
      }
      for (let i = 0; i < meteorSlots.length; i += 1) {
        const slot = meteorSlots[i]!;
        if (!slot.active) continue;
        slot.age += dt;
        const p = slot.age / slot.duration;
        if (p >= 1 || night <= 0.25) {
          slot.active = false;
          slot.mesh.visible = false;
          slot.mat.uniforms["uAlpha"]!.value = 0;
          continue;
        }
        meteorScratchPos.lerpVectors(slot.startPos, slot.endPos, p);
        slot.mesh.position.copy(meteorScratchPos);
        // X축 = 유성 진행 방향, Z축 = 원점(지상 관측자)을 향하는 법선
        meteorScratchNormal.copy(meteorScratchPos).negate().normalize();
        slot.side.crossVectors(meteorScratchNormal, slot.dir).normalize();
        meteorScratchNormal.crossVectors(slot.dir, slot.side).normalize();
        meteorScratchBasis.makeBasis(slot.dir, slot.side, meteorScratchNormal);
        slot.mesh.quaternion.setFromRotationMatrix(meteorScratchBasis);
        const env = Math.sin(p * Math.PI);
        slot.mat.uniforms["uAlpha"]!.value = env * Math.min(1, (night - 0.25) / 0.45);
      }

      // 날씨 파티클 갱신 (단일 InstancedMesh 360기, clear 시 0 비용)
      if (currentWeather !== "clear") {
        weatherInstanced.visible = true;
        const wrapSpan = 72;
        const halfSpan = 36;
        const heightSpan = 28;
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
      fireflyGeo.dispose();
      fireflyMat.dispose();
      meteorGeo.dispose();
      for (const slot of meteorSlots) {
        slot.mat.dispose();
      }
      weatherInstanced.dispose();
      weatherGeo.dispose();
      weatherMat.dispose();
      rainbowGeo.dispose();
      rainbowMat.dispose();
      auroraGeo.dispose();
      auroraMat.dispose();
      scene.remove(group);
    },
  };

  return rig;
}
