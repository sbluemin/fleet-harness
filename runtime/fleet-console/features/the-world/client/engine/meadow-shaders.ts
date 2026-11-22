/**
 * 초원 씬(meadow-scene.ts) 전용 WebGL2/GLSL3 셰이더 모음.
 * - 시냇물/연못 물결·카우스틱·강둑 거품·빗방울 파문 (`BROOK_*`)
 * - 우물/분수 동심원 수면 (`FOUNTAIN_WATER_*`)
 * - 심시티 구역 호버/선택 하이라이트 링 (`HIGHLIGHT_*`)
 * - 이중 레이어 모닥불 화염·숨 쉬는 숯불 글로우·상승 불티 (`CAMPFIRE_*`)
 */

export const BROOK_VERTEX = /* glsl */ `
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

export const BROOK_FRAGMENT = /* glsl */ `
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
  vec3 nightShallow = vec3(0.06, 0.20, 0.36);
  vec3 nightDeep = vec3(0.03, 0.09, 0.22);

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

  vec3 causticCol = mix(vec3(0.76, 0.98, 1.0), vec3(0.36, 0.58, 0.86), uNight);
  vec3 col = mix(baseCol, causticCol, caustics * (0.28 - uNight * 0.12));

  // 강둑(shoreline) & 목교 교각 하얀 물거품 테두리 (수로 밖 거품 번짐 방지용 좁은 밴드+알파 클램프)
  float waveWobble = sin(vWorldPos.x * 2.4 - uTime * 3.1) * 0.05 + cos(vWorldPos.z * 3.2 + uTime * 2.2) * 0.035;
  float shorePos = vShore + waveWobble;
  float shoreBand = smoothstep(0.76, 0.92, shorePos) * (1.0 - smoothstep(0.98, 1.12, shorePos));
  float innerFroth = smoothstep(0.60, 0.78, shorePos) * (1.0 - smoothstep(0.94, 1.06, shorePos)) * c1 * 0.58;
  float bridgeFoam = vBridgeProx * smoothstep(0.20, 0.75, c1 + 0.35 * sin(vWorldPos.z * 5.0 - uTime * 4.0)) * 0.75;
  float foamMask = clamp(shoreBand * 0.88 + innerFroth + bridgeFoam, 0.0, 1.0);
  vec3 foamCol = mix(vec3(0.95, 0.99, 1.0), vec3(0.46, 0.60, 0.78), uNight * 0.82);
  col = mix(col, foamCol, foamMask);

  // 프레넬 하늘 반사 + 태양/달빛 반짝임(sparkle glints)
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.8) * 0.38;
  vec3 skyRefl = mix(mix(vec3(0.72, 0.93, 1.0), vec3(0.98, 0.68, 0.48), sunsetFactor * 0.75), vec3(0.18, 0.30, 0.54), uNight);
  col = mix(col, skyRefl, fres * (1.0 - foamMask * 0.6));

  vec3 H = normalize(L + V);
  float specBase = pow(max(dot(N, H), 0.0), 72.0);
  float sparkleNoise = sin(vWorldPos.x * 7.5 - uTime * 4.4) * cos(vWorldPos.z * 6.8 + uTime * 3.6);
  float glint = smoothstep(0.62, 0.96, sparkleNoise) * (0.35 + specBase * 2.2) * (1.0 - foamMask * 0.7);
  vec3 glintCol = mix(vec3(1.0, 0.98, 0.88), vec3(0.78, 0.88, 1.0), uNight);
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
    vec3 rippleCol = mix(vec3(0.92, 0.98, 1.0), vec3(0.56, 0.72, 0.90), uNight);
    col = mix(col, rippleCol, rainRipple * 0.62);
  }

  float bankAlpha = 1.0 - smoothstep(0.94, 1.10, vShore);
  float channelFade = 1.0 - smoothstep(76.0, 86.0, abs(vWorldPos.x));
  float waterAlpha = mix(0.88, 0.95, foamMask) * bankAlpha * channelFade;
  if (waterAlpha < 0.02) discard;

  fragColor = vec4(col, waterAlpha);
}
`;

export const FOUNTAIN_WATER_VERTEX = /* glsl */ `
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

export const FOUNTAIN_WATER_FRAGMENT = /* glsl */ `
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

  vec3 shallow = mix(vec3(0.24, 0.84, 0.84), vec3(0.08, 0.24, 0.42), uNight);
  vec3 deep = mix(vec3(0.10, 0.54, 0.86), vec3(0.04, 0.13, 0.30), uNight);
  vec3 col = mix(deep, shallow, r * 0.65 + ring * 0.35);
  vec3 foam = mix(vec3(0.95, 0.99, 1.0), vec3(0.50, 0.66, 0.84), uNight * 0.78);
  col = mix(col, foam, clamp(rimFoam * 0.72 + centerSplash * 0.65 + ring * 0.28, 0.0, 0.92));

  fragColor = vec4(col, 0.92);
}
`;

export const HIGHLIGHT_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const HIGHLIGHT_FRAGMENT = /* glsl */ `
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

/**
 * 모닥불 이중 레이어 흔들리는 화염 셰이더 (InstancedMesh 공용, 외곽 주황·황금 화염 + 내부 밝은 코어).
 */
export const CAMPFIRE_FLAME_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uCore;

out vec2 vUv;
out float vSeed;
out float vFacing;

void main() {
  vUv = uv;
  float h = clamp(uv.y, 0.0, 1.0);
  float h2 = h * h;

  vec3 instOrigin = vec3(0.0);
  #ifdef USE_INSTANCING
    instOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  #endif
  float seed = fract(sin(dot(instOrigin.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
  vSeed = seed;

  vec3 lp = position;
  float speed = mix(7.2, 9.4, uCore);
  float swayX = (sin(uTime * speed + seed + h * 4.4) * 0.11 + cos(uTime * (speed * 1.45) + seed * 1.7 - h * 5.2) * 0.045) * h2;
  float swayZ = (cos(uTime * (speed * 0.88) + seed * 1.3 + h * 3.9) * 0.10 + sin(uTime * (speed * 1.32) + seed - h * 4.6) * 0.04) * h2;
  float breath = 1.0 + sin(uTime * 11.2 + seed * 2.1 - h * 3.5) * 0.08 * h;

  lp.x = lp.x * breath + swayX;
  lp.z = lp.z * breath + swayZ;
  lp.y *= 1.0 + sin(uTime * 13.4 + seed) * 0.09 * h;

  #ifdef USE_INSTANCING
    vec4 wp = modelMatrix * instanceMatrix * vec4(lp, 1.0);
    vec3 wn = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  #else
    vec4 wp = modelMatrix * vec4(lp, 1.0);
    vec3 wn = normalize(mat3(modelMatrix) * normal);
  #endif

  vec3 viewDir = normalize(cameraPosition - wp.xyz);
  vFacing = abs(dot(wn, viewDir));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const CAMPFIRE_FLAME_FRAGMENT = /* glsl */ `
in vec2 vUv;
in float vSeed;
in float vFacing;
out vec4 fragColor;

uniform float uTime;
uniform float uCore;
uniform float uNight;

void main() {
  float h = clamp(vUv.y, 0.0, 1.0);
  float ang = vUv.x * 6.2831853;

  // 상승하는 3중 화염 혀 패턴 (단순 원뿔 느낌 완전 제거)
  float tongue1 = sin(ang * 3.0 + uTime * 3.8 + vSeed - h * 5.6);
  float tongue2 = sin(ang * 5.0 - uTime * 5.4 + vSeed * 1.9 - h * 7.8) * 0.55;
  float flicker = sin(uTime * 15.0 + vSeed + h * 4.0) * 0.08;
  float tongueNoise = (tongue1 + tongue2) * 0.14 * h;

  float tipMask = smoothstep(0.98, 0.42, h + tongueNoise);
  float baseMask = smoothstep(0.0, 0.14, h);
  float edgeSoft = smoothstep(0.04, 0.42, vFacing);

  float alpha = tipMask * baseMask * mix(0.68, 1.0, edgeSoft) * mix(0.90, 0.96, uCore);
  if (alpha < 0.03) discard;

  // 외곽: 주홍→오렌지→황금 / 내부 코어: 황금→밝은 크림 백열
  vec3 outerCol = mix(
    vec3(1.02, 0.28, 0.04),
    mix(vec3(1.06, 0.56, 0.08), vec3(1.12, 0.88, 0.28), smoothstep(0.28, 0.85, h)),
    smoothstep(0.05, 0.62, h)
  );
  vec3 coreCol = mix(
    vec3(1.10, 0.78, 0.18),
    vec3(1.32, 1.18, 0.76),
    smoothstep(0.10, 0.72, h + vFacing * 0.25)
  );

  vec3 col = mix(outerCol, coreCol, uCore);
  col *= (1.0 + flicker) * (1.02 + uNight * 0.34);

  fragColor = vec4(col, alpha);
}
`;

/**
 * 모닥불 바닥 붉게 숨 쉬는 숯불 글로우 디스크 셰이더 (InstancedMesh 1 draw call).
 */
export const CAMPFIRE_COAL_VERTEX = /* glsl */ `
out vec2 vUv;
out float vSeed;

void main() {
  vUv = uv;
  vec3 instOrigin = vec3(0.0);
  #ifdef USE_INSTANCING
    instOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vec4 wp = modelMatrix * vec4(position, 1.0);
  #endif
  vSeed = fract(sin(dot(instOrigin.xz, vec2(19.19, 91.37))) * 43758.5453) * 6.2831;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const CAMPFIRE_COAL_FRAGMENT = /* glsl */ `
in vec2 vUv;
in float vSeed;
out vec4 fragColor;

uniform float uTime;
uniform float uNight;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  float breath = 0.72 + 0.28 * sin(uTime * 3.1 + vSeed) + 0.10 * sin(uTime * 7.8 + vSeed * 2.1);
  // 숯덩이 사이로 비치는 균열 발광 패턴
  float crack = sin(p.x * 11.5 + sin(p.y * 8.5 + vSeed)) * cos(p.y * 10.5 - sin(p.x * 7.2));
  float emberMask = smoothstep(-0.25, 0.65, crack) * smoothstep(0.95, 0.22, r);
  float coreGlow = smoothstep(0.76, 0.0, r);

  vec3 charCol = vec3(0.14, 0.08, 0.07);
  vec3 redCoal = vec3(1.12, 0.24, 0.04) * breath;
  vec3 hotCore = vec3(1.25, 0.62, 0.12) * breath;

  vec3 col = mix(charCol, redCoal, clamp(emberMask * 0.92 + coreGlow * 0.55, 0.0, 1.0));
  col = mix(col, hotCore, coreGlow * emberMask * 0.72);
  col *= 1.0 + uNight * 0.42;

  float alpha = smoothstep(1.0, 0.58, r) * 0.94;
  fragColor = vec4(col, alpha);
}
`;

/**
 * 활성 작업 구역 마당용 회전 홀로그램 작전 도면 링 셰이더 (InstancedMesh 1 draw call, AdditiveBlending).
 */
export const HOLO_TABLE_RING_VERTEX = /* glsl */ `
out vec2 vUv;
out vec3 vColor;
out float vSeed;

void main() {
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
    vColor = instanceColor;
  #else
    vColor = vec3(0.32, 0.86, 1.0);
  #endif
  vec3 instOrigin = vec3(0.0);
  #ifdef USE_INSTANCING
    instOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vec4 wp = modelMatrix * vec4(position, 1.0);
  #endif
  vSeed = fract(sin(dot(instOrigin.xz, vec2(17.3, 41.9))) * 43758.5453) * 6.2831;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const HOLO_TABLE_RING_FRAGMENT = /* glsl */ `
in vec2 vUv;
in vec3 vColor;
in float vSeed;
out vec4 fragColor;

uniform float uTime;
uniform float uNight;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  float ang = atan(p.y, p.x);
  float outerRing = smoothstep(0.98, 0.92, r) * smoothstep(0.78, 0.86, r);
  float ticks = smoothstep(0.15, 0.55, sin(ang * 12.0 - uTime * 2.2 + vSeed));
  float innerRing = smoothstep(0.58, 0.54, r) * smoothstep(0.45, 0.50, r);
  float innerDash = smoothstep(-0.2, 0.35, sin(ang * 6.0 + uTime * 3.1 + vSeed));

  // 회전 레이더 스캔선 + 중앙 좌표 십자
  float scan = smoothstep(0.84, 0.99, cos(ang - uTime * 2.6 - vSeed)) * smoothstep(0.90, 0.14, r) * 0.42;
  float crossH = smoothstep(0.045, 0.012, abs(p.y)) * smoothstep(0.62, 0.08, abs(p.x)) * 0.45;
  float crossV = smoothstep(0.045, 0.012, abs(p.x)) * smoothstep(0.62, 0.08, abs(p.y)) * 0.45;
  float coreDot = smoothstep(0.16, 0.04, r) * (0.72 + 0.28 * sin(uTime * 4.5 + vSeed));

  float pattern = outerRing * (0.55 + ticks * 0.45)
    + innerRing * (0.45 + innerDash * 0.55) * 0.85
    + scan + crossH + crossV + coreDot;
  float baseWash = smoothstep(0.92, 0.10, r) * 0.16;

  float alpha = clamp(pattern * 0.78 + baseWash, 0.0, 0.92) * (0.85 + uNight * 0.25);
  if (alpha < 0.02) discard;

  vec3 col = mix(vColor, vec3(0.94, 0.99, 1.0), clamp(coreDot * 0.65 + outerRing * 0.35, 0.0, 0.85));
  col *= 1.05 + uNight * 0.35;
  fragColor = vec4(col, alpha);
}
`;
