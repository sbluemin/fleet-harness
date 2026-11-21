import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  LineSegments,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { MapBranchKey, MapNode } from "../map-graph.js";
import { mapPaletteToRgb, type MapPalette } from "../map-palette.js";
import { rng32 } from "../map-random.js";
import type { MapRenderer, PositionedMapModel } from "../map-renderers.js";
import { prefersReducedMotion } from "../../../../../core/client/src/integration/reduced-motion.js";

/**
 * three.js WebGL2 렌더러 — 생체 시냅스 광학 + 절제된 성도 극좌표(A+B 절충안).
 * 이 파일과 three는 지도를 열 때만 받는 지연 청크다.
 *
 * - 후처리 블룸 없이 네이티브 MSAA + 분석 SDF 셰이더로 그려 다크의 백색 포화·배경 안개와
 *   라이트의 Beer-Lambert 수채화 얼룩을 모두 제거한다.
 * - z=0 평면에 절제된 극좌표 눈금·6갈래 구역 틴트·사령관 톤 코어 광원을 두어 360° 회전 시
 *   공간 지형이 함께 기울어지며, 연결선은 화면 공간 폭을 가진 2차 베지에 시냅스 리본으로 그린다.
 * - 카메라는 정면이 기본이고 자동 회전은 없다(결정 ff40284e) — 끌 때만 돌고 손을 떼면 머문다.
 * - WebGL2 컨텍스트 1개. CSP 때문에 blob 워커·WASM·eval은 쓰지 않는다.
 */

/** 맞춤 보기 여백(CSS px) — 라벨·패널이 덮는 폭. */
export interface MapFitInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface MapWebglRenderer extends MapRenderer {
  /** 맞춤 보기 여백 갈아끼우기. 기본값은 아래 `DEFAULT_INSETS`. */
  setFitInsets(insets: MapFitInsets): void;
}

const DEFAULT_INSETS: MapFitInsets = { top: 36, right: 36, bottom: 36, left: 36 };

/** 배치(반지름 ≈1.8) → 무대 단위(반지름 ≈380). */
const WORLD_SCALE = 200;
const FOV_DEG = 42;
const FIT_MARGIN = 1.05;
const Z_SCALE_MAX = 2.4;
const STRETCH_MAX = 1.85;
/** 점 스프라이트 반지름 배율 — 0..0.42가 본체, 0.42..1.0이 고리·레티클·광환 몫이다. */
const SPRITE_K = 4.6;
const BODY_NORM_R = 0.42;
const MAX_SPRITE_CSS = 84;
const FOCUS_RANGE_MIN = 160;
const FOCUS_RANGE_RATIO = 0.36;
const MIN_HIT_PX = 6;
const MAX_PIXEL_RATIO = 1.75;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.6;
/** 끌기 감도(rad/px) — 각도 제한 없이 360도 돈다. */
const DRAG_RAD_PER_PX = 0.0045;
const DRAG_THRESHOLD_PX = 3;
const FIT_TWEEN_MS = 450;
/** 맥동·시냅스 펄스 간격 — 움직임이 없을 때는 30fps로 절약한다. */
const PULSE_FRAME_MS = 33;
/** 밀도 보정 구간 — 규모 40~200 사이에서 반경·알파를 완만하게 조절한다. */
const CROWD_FROM = 40;
const CROWD_TO = 200;
/** 곡선 시냅스 리본의 세그먼트 수(엣지 1개당 12구간 = 24삼각형). */
const EDGE_SEGMENTS = 12;

// ── 셰이더 ───────────────────────────────────────────────────────────────────

/** Layer 0a: 6갈래 구역 틴트 웨지 + 사령관 정체성 톤 중앙 광원(z=0 평면). */
const BACKDROP_PLANE_VERTEX = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const BACKDROP_PLANE_FRAGMENT = /* glsl */ `
uniform float uRadius;
uniform float uLight;
uniform float uFocusDim;
uniform float uTime;
uniform float uMotion;
uniform vec3 uCoreRgb;
uniform vec3 uBranchRgb[6];
uniform float uBranchAngle[6];
uniform float uBranchActive[6];
varying vec2 vLocal;

float angleDiff(float a, float b) {
  float d = mod(a - b + 3.14159265, 6.2831853) - 3.14159265;
  return abs(d);
}

void main() {
  float r = length(vLocal) / max(uRadius, 1.0);
  if (r > 1.25) discard;
  float ang = atan(vLocal.y, vLocal.x);

  // 1) 사령관 정체성 톤 중심 스포트라이트 광원(미세 호흡)
  float breath = 1.0 + (uMotion > 0.5 ? 0.035 * sin(uTime * 1.15) : 0.0);
  float coreFalloff = exp(-r * r * (3.1 / breath));
  float coreAlpha = coreFalloff * mix(0.145, 0.075, uLight) * mix(1.0, 0.55, uFocusDim);
  vec3 col = uCoreRgb * coreAlpha;
  float alpha = coreAlpha;

  // 2) 절제된 6갈래 구역 웨지 틴트(성도 B 요소)
  float radialEnv = smoothstep(0.08, 0.36, r) * (1.0 - smoothstep(0.62, 1.12, r));
  float wedgePeak = mix(0.075, 0.068, uLight) * mix(1.0, 0.35, uFocusDim);
  for (int i = 0; i < 6; i++) {
    if (uBranchActive[i] < 0.5) continue;
    float da = angleDiff(ang, uBranchAngle[i]);
    float angularEnv = smoothstep(0.47, 0.04, da);
    float wa = radialEnv * angularEnv * wedgePeak;
    col += uBranchRgb[i] * wa;
    alpha += wa;
  }

  if (alpha <= 0.001) discard;
  vec3 outCol = col / max(alpha, 0.0001);
  gl_FragColor = vec4(outCol, clamp(alpha, 0.0, 0.32));
}`;

/** Layer 0b: 보정된 극좌표 링·나침반 틱·십자선. */
const GUIDE_VERTEX = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GUIDE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uFocusDim;
varying float vAlpha;
void main() {
  float a = vAlpha * mix(1.0, 0.45, uFocusDim);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(uColor, a);
}`;

/** Layer 0c: 다크 전용 미세 심도 성진(드래그 회전 시 3D 시차). */
const DUST_VERTEX = /* glsl */ `
attribute float aPhase;
attribute float aSize;
uniform float uPixelRatio;
uniform float uTime;
uniform float uMotion;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float tw = uMotion > 0.5 ? (0.5 + 0.5 * sin(uTime * 0.9 + aPhase)) : 0.5;
  vAlpha = 0.05 + 0.09 * tw;
  gl_PointSize = aSize * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}`;

const DUST_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uLight;
varying float vAlpha;
void main() {
  if (uLight > 0.5) discard;
  float d = length(gl_PointCoord * 2.0 - 1.0);
  if (d > 1.0) discard;
  float core = smoothstep(1.0, 0.2, d);
  gl_FragColor = vec4(uColor, core * vAlpha);
}`;

/** Layer 1: 화면 공간 두께·곡률·점선·시냅스 펄스를 갖는 2차 베지에 축삭 리본. */
const RIBBON_VERTEX = /* glsl */ `
attribute vec3 aTangent;
attribute float aSide;
attribute float aU;
attribute float aDist;
attribute float aWidth;
attribute float aAlpha;
attribute float aDash;
attribute float aPulse;
attribute float aPhase;
attribute vec3 aColorA;
attribute vec3 aColorB;

uniform vec2 uResolution;
uniform float uLight;

varying float vSide;
varying float vU;
varying float vDist;
varying float vWidth;
varying float vAlpha;
varying float vDash;
varying float vPulse;
varying float vPhase;
varying vec3 vColorA;
varying vec3 vColorB;
varying float vSheath;

void main() {
  vSide = aSide;
  vU = aU;
  vDist = aDist;
  vWidth = aWidth;
  vAlpha = aAlpha;
  vDash = aDash;
  vPulse = aPulse;
  vPhase = aPhase;
  vColorA = aColorA;
  vColorB = aColorB;

  if (aAlpha <= 0.001 || aWidth <= 0.01) {
    vSheath = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 clipNext = projectionMatrix * modelViewMatrix * vec4(position + aTangent, 1.0);
  vec2 ndcPos = clipPos.xy / max(abs(clipPos.w), 0.0001);
  vec2 ndcNext = clipNext.xy / max(abs(clipNext.w), 0.0001);
  vec2 dirPx = (ndcNext - ndcPos) * uResolution * 0.5;
  float dirLen = length(dirPx);
  vec2 normalPx = dirLen > 0.0001 ? vec2(-dirPx.y, dirPx.x) / dirLen : vec2(0.0, 1.0);

  // 다크 줄기·링크·강조 선은 은은한 발광 피복(sheath)을 얹는다.
  float sheathPx = (uLight < 0.5 && (aWidth >= 1.35 || aPulse > 0.5)) ? 2.6 : 0.0;
  vSheath = sheathPx;
  float halfPx = aWidth * 0.5 + 0.9 + sheathPx;
  vec2 offsetNdc = normalPx * aSide * halfPx * (2.0 / uResolution);
  clipPos.xy += offsetNdc * clipPos.w;
  gl_Position = clipPos;
}`;

const RIBBON_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uMotion;
uniform float uLight;
uniform vec3 uFreshRgb;

varying float vSide;
varying float vU;
varying float vDist;
varying float vWidth;
varying float vAlpha;
varying float vDash;
varying float vPulse;
varying float vPhase;
varying vec3 vColorA;
varying vec3 vColorB;
varying float vSheath;

void main() {
  if (vAlpha <= 0.001) discard;

  float halfTotal = vWidth * 0.5 + 0.9 + vSheath;
  float distPx = abs(vSide) * halfTotal;
  float halfCore = vWidth * 0.5;

  // 중심 섬유 안티앨리어싱
  float coreMask = 1.0 - smoothstep(max(0.0, halfCore - 0.35), halfCore + 0.65, distPx);
  // 다크 발광 피복(가산 포화 없이 제어된 알파)
  float sheathMask = vSheath > 0.01
    ? exp(-pow(max(0.0, distPx - halfCore) / max(vSheath * 0.65, 0.5), 2.0)) * 0.28
    : 0.0;

  // 목표·출처 점선 처리
  float dashMask = 1.0;
  if (vDash > 0.5) {
    float cyc = mod(vDist, 14.0);
    dashMask = smoothstep(0.0, 1.0, cyc) * (1.0 - smoothstep(5.5, 6.8, cyc));
  }

  vec3 baseCol = mix(vColorA, vColorB, vU);
  float outAlpha = (coreMask * vAlpha + sheathMask * vAlpha) * dashMask;
  vec3 outCol = baseCol;

  // 시냅스 펄스 — 줄기·명시 링크·호버 경로를 따라 흐르는 부드러운 신호 패킷
  if (vPulse > 0.5 && uMotion > 0.5) {
    float speed = vPulse > 1.5 ? 0.56 : 0.30;
    float head = fract(uTime * speed + vPhase);
    float dU = abs(vU - head);
    dU = min(dU, 1.0 - dU);
    float packet = exp(-dU * dU * 190.0);
    float radial = exp(-pow(distPx / max(vWidth * 1.15 + 1.4, 1.6), 2.0));
    float pIntensity = packet * radial * dashMask;
    vec3 sparkCol = vPulse > 1.5
      ? mix(uFreshRgb, vec3(1.0), uLight > 0.5 ? 0.0 : 0.45)
      : mix(baseCol, vec3(1.0), uLight > 0.5 ? 0.05 : 0.55);
    outCol = mix(outCol, sparkCol, clamp(pIntensity * 0.9, 0.0, 1.0));
    outAlpha = max(outAlpha, pIntensity * mix(0.92, 0.78, uLight));
  }

  if (outAlpha <= 0.002) discard;
  gl_FragColor = vec4(outCol, clamp(outAlpha, 0.0, 0.98));
}`;

/** Layer 2: 다중 도형 SDF 광학 노드(구슬 · 사령관 핵 · 허브 · 마름모 정보 · 중공 목표 · +N 묶음). */
const POINT_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aShape;
attribute float aFresh;
attribute float aStale;
attribute float aActive;

uniform float uScale;
uniform float uFocus;
uniform float uRange;
uniform float uMaxPx;
uniform float uLight;

varying vec3 vColor;
varying float vAlpha;
varying float vCoc;
varying float vShape;
varying float vFresh;
varying float vStale;
varying float vActive;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 1.0);
  float coc = clamp(abs(depth - uFocus) / uRange, 0.0, 1.0);
  vCoc = coc;
  vShape = aShape;
  vColor = aColor;
  vFresh = aFresh;
  vStale = aStale;
  vActive = aActive;

  // 제어된 심도 감쇠 — 멀어져도 흐릿한 비눗방울로 번지지 않고 대비만 부드럽게 물러난다.
  float depthFade = mix(1.0, mix(0.68, 0.74, uLight), coc);
  vAlpha = aAlpha * depthFade;
  float spritePx = (aSize * uScale / depth) * (1.0 + coc * 0.14);
  gl_PointSize = min(spritePx, uMaxPx);
  gl_Position = projectionMatrix * mv;
}`;

const POINT_FRAGMENT = /* glsl */ `
uniform float uLight;
uniform float uTime;
uniform float uMotion;
uniform vec3 uFreshRgb;
uniform vec3 uStaleRgb;
uniform vec3 uInkRgb;
uniform vec3 uStageRgb;

varying vec3 vColor;
varying float vAlpha;
varying float vCoc;
varying float vShape;
varying float vFresh;
varying float vStale;
varying float vActive;

// 직선 점선 고리 마스크
float ringMask(float d, float r, float halfW) {
  return smoothstep(r + halfW + 0.025, r + halfW - 0.015, d)
       * smoothstep(r - halfW - 0.025, r - halfW + 0.015, d);
}

// 3D 광학 구슬(다크=생체 발광 핵, 라이트=광학 법랑 비드)
vec4 shadeBead(vec2 p, float r, vec3 baseCol, float isMajor) {
  float d = length(p);
  float mask = smoothstep(r + 0.025, r - 0.025, d);
  if (mask <= 0.001) return vec4(0.0);
  vec2 nxy = clamp(p / max(r, 0.001), -1.0, 1.0);
  float nz = sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
  vec3 N = normalize(vec3(nxy, nz));
  vec3 L = normalize(vec3(-0.42, -0.45, 0.78));
  float ndl = max(dot(N, L), 0.0);
  float spec = pow(ndl, 5.5);
  float rim = pow(1.0 - nz, 2.2);

  // 소프트니 스페큘러 — 하이라이트는 선명하되 순백으로 타지 않는다.
  vec3 lit = mix(baseCol * mix(0.66, 0.72, uLight), baseCol * 1.06, ndl);
  lit = mix(lit, vec3(1.0), spec * mix(isMajor > 0.5 ? 0.56 : 0.44, isMajor > 0.5 ? 0.52 : 0.40, uLight));

  // 외곽 미세 림 — 200개 밀집에서도 겹친 구슬 경계가 분리된다.
  vec3 rimCol = uLight > 0.5
    ? vec3(1.0)
    : mix(baseCol, vec3(1.0), 0.38);
  lit = mix(lit, rimCol, rim * mix(isMajor > 0.5 ? 0.52 : 0.30, 0.62, uLight));
  return vec4(lit, mask);
}

void main() {
  if (vAlpha <= 0.002) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;

  float R = ${BODY_NORM_R.toFixed(2)};
  float angle = atan(p.y, p.x);
  int shape = int(vShape + 0.5);

  vec3 accCol = vec3(0.0);
  float accA = 0.0;

  // 헬퍼: premultiplied-like source-over 누적
  // 1) 배경 광환(다크) 또는 미세 접지 그림자(라이트)
  if (uLight < 0.5) {
    float isBig = (shape == 1 || shape == 2) ? 1.0 : 0.0;
    float coronaK = shape == 1 ? 3.4 : (isBig > 0.5 ? 4.4 : 6.2);
    float corona = exp(-d * d * coronaK) * smoothstep(1.0, 0.45, d);
    float coronaA = corona * (shape == 1 ? 0.52 : isBig > 0.5 ? 0.36 : 0.24) * vAlpha;
    if (coronaA > 0.001) {
      accCol = vColor;
      accA = coronaA;
    }
  } else {
    // 라이트: 탁한 수채화 번짐 대신 선명한 접지 그림자 + 주요 허브의 맑은 틴트 링
    float shadowD = length(p - vec2(0.0, 0.065));
    float shadow = smoothstep(R * 1.18, R * 0.55, shadowD) * 0.14 * vAlpha;
    if (shadow > 0.001) {
      accCol = vec3(0.08, 0.11, 0.16);
      accA = shadow;
    }
    if (shape == 1 || shape == 2) {
      float tintGlow = exp(-pow((d - R * 0.7) / 0.34, 2.0)) * smoothstep(1.0, 0.5, d) * 0.16 * vAlpha;
      accCol = mix(accCol, vColor, tintGlow / max(accA + tintGlow, 0.0001));
      accA = accA + tintGlow * (1.0 - accA);
    }
  }

  // 2) 본체 SDF (shape: 0=기억 구슬, 1=사령관 핵, 2=갈래 허브, 3=정보 마름모, 4=목표 중공 링, 5=+N 묶음)
  vec4 body = vec4(0.0);
  if (shape == 3) {
    // 정보: 45도 회전 둥근 마름모 크리스탈
    vec2 q = abs(p);
    float diam = (q.x + q.y) * 0.78;
    float s = R * 1.04;
    float mask = smoothstep(s + 0.03, s - 0.025, diam);
    float facet = clamp(0.5 - (p.x + p.y) * 0.65, 0.0, 1.0);
    vec3 dCol = mix(vColor * 0.78, mix(vColor, vec3(1.0), 0.36), facet);
    float edge = smoothstep(s - 0.08, s - 0.01, diam) * mask;
    vec3 rimC = uLight > 0.5 ? vec3(1.0) : mix(vColor, vec3(1.0), 0.45);
    body = vec4(mix(dCol, rimC, edge * 0.65), mask * 0.96);
  } else if (shape == 4) {
    // 목표: 얇고 정교한 중공 링 + 미세 중앙 핀(밀집 시 중심 시야를 막지 않게 절제)
    float outerDisc = smoothstep(R * 0.96 + 0.02, R * 0.96 - 0.02, d);
    float ring = ringMask(d, R * 0.86, 0.046);
    float pin = smoothstep(R * 0.23 + 0.02, R * 0.23 - 0.02, d);
    vec3 fillBg = mix(uStageRgb, vColor, 0.04);
    float strokeMask = clamp(ring + pin, 0.0, 1.0);
    body = vec4(mix(fillBg, vColor, strokeMask), outerDisc * 0.92);
  } else if (shape == 5) {
    // +N 묶음: 외곽 링 + 내부 공전 3점
    float ring = ringMask(d, R * 0.98, 0.062);
    float dots = 0.0;
    float rot = uMotion > 0.5 ? uTime * 0.4 : 0.0;
    for (int k = 0; k < 3; k++) {
      float ka = float(k) * 2.0943951 + rot;
      vec2 c = vec2(cos(ka), sin(ka)) * (R * 0.44);
      dots = max(dots, smoothstep(0.11, 0.06, length(p - c)));
    }
    float mask = clamp(ring + dots, 0.0, 1.0);
    body = vec4(mix(vColor, vec3(1.0), dots * 0.25), mask * 0.94);
  } else {
    // 0(기억·주제·출처), 1(사령관 핵), 2(갈래 허브)
    float isMajor = (shape == 1 || shape == 2) ? 1.0 : 0.0;
    body = shadeBead(p, R, vColor, isMajor);
  }

  // 본체 합성
  float bodyA = body.a * vAlpha;
  if (bodyA > 0.001) {
    accCol = mix(accCol, body.rgb, bodyA / max(bodyA + accA * (1.0 - bodyA), 0.0001));
    accA = bodyA + accA * (1.0 - bodyA);
  }

  // 3) 핵·허브 구조 링 + 성도 나침반 눈금(A+B 핵심 정체성)
  if (shape == 1) {
    float pulse = uMotion > 0.5 ? (0.5 + 0.5 * sin(uTime * 2.1)) : 0.5;
    float innerRing = ringMask(d, R * (1.36 + pulse * 0.11), 0.026);
    float dashOuter = step(0.0, sin(angle * 12.0));
    float outerRing = ringMask(d, R * 1.82, 0.020) * dashOuter;
    // 4방위 미세 나침반 틱
    float axisAlign = max(smoothstep(0.032, 0.008, abs(p.x)), smoothstep(0.032, 0.008, abs(p.y)));
    float tickBand = smoothstep(R * 1.28, R * 1.32, d) * (1.0 - smoothstep(R * 1.98, R * 2.04, d));
    float ticks = axisAlign * tickBand * 0.55;
    float ringA = clamp(innerRing * 0.55 + outerRing * 0.26 + ticks * 0.45, 0.0, 1.0) * vAlpha;
    if (ringA > 0.001) {
      accCol = mix(accCol, vColor, ringA / max(ringA + accA * (1.0 - ringA), 0.0001));
      accA = ringA + accA * (1.0 - ringA);
    }
  } else if (shape == 2) {
    float collar = ringMask(d, R * 1.38, 0.028) * 0.48 * vAlpha;
    if (collar > 0.001) {
      accCol = mix(accCol, vColor, collar / max(collar + accA * (1.0 - collar), 0.0001));
      accA = collar + accA * (1.0 - collar);
    }
  }

  // 4) 상태 신호(카테고리 색과 완전 분리) — fresh: 회전 청록 아크, stale: 점선 호박 고리
  if (vFresh > 0.5 && shape != 1) {
    float shift = uMotion > 0.5 ? uTime * 0.9 : 0.0;
    float aRel = mod(angle - shift + 6.2831853, 6.2831853);
    float arc = smoothstep(0.0, 0.25, aRel) * (1.0 - smoothstep(3.6, 3.9, aRel));
    float fRing = ringMask(d, R * 1.36, 0.038) * arc * mix(0.92, 0.85, uLight) * vAlpha;
    if (fRing > 0.001) {
      accCol = mix(accCol, uFreshRgb, fRing / max(fRing + accA * (1.0 - fRing), 0.0001));
      accA = fRing + accA * (1.0 - fRing);
    }
  }

  if (vStale > 0.5) {
    float dashes = smoothstep(-0.15, 0.15, sin(angle * 10.0));
    float sRing = ringMask(d, R * 1.48, 0.034) * dashes * 0.90 * vAlpha;
    if (sRing > 0.001) {
      accCol = mix(accCol, uStaleRgb, sRing / max(sRing + accA * (1.0 - sRing), 0.0001));
      accA = sRing + accA * (1.0 - sRing);
    }
  }

  // 5) 호버·선택 정밀 4분할 조준 레티클(성도 B 요소)
  if (vActive > 0.5) {
    float quadGap = smoothstep(0.18, 0.30, abs(sin(angle * 2.0)));
    float ret = ringMask(d, R * 1.72, 0.036) * quadGap * 0.94;
    if (ret > 0.001) {
      vec3 retCol = vActive > 1.5 ? uInkRgb : mix(vColor, uInkRgb, 0.45);
      accCol = mix(accCol, retCol, ret / max(ret + accA * (1.0 - ret), 0.0001));
      accA = ret + accA * (1.0 - ret);
    }
  }

  if (accA <= 0.003) discard;
  gl_FragColor = vec4(accCol, clamp(accA, 0.0, 1.0));
}`;

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const IDENTITY = new Quaternion();
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

type Rgb = readonly [number, number, number];
type PaletteRgb = ReturnType<typeof mapPaletteToRgb>;

const Z_SPAN: Partial<Record<MapNode["kind"], number>> = {
  core: 0, "intel-hub": 45, branch: 45, description: 35, topic: 105,
  memory: 270, intel: 170, "intel-overflow": 170, objective: 360, source: 340,
};

function depthOf(node: MapNode): number {
  let h = 2166136261;
  for (let i = 0; i < node.id.length; i += 1) h = Math.imul(h ^ node.id.charCodeAt(i), 16777619);
  const u = ((h >>> 0) % 10007) / 10007 - 0.5;
  return u * (Z_SPAN[node.kind] ?? 130);
}

function radiusOf(node: MapNode, degree: number): number {
  switch (node.kind) {
    case "core": return 20;
    case "branch": case "intel-hub": case "description": return 10.5;
    case "topic": return 5.2;
    case "objective": return 4.4 + Math.min(2.6, degree * 0.32);
    case "source": return 5.4 + Math.min(3.4, degree * 0.42);
    case "intel": return 5.4;
    case "intel-overflow": return 8.2;
    case "memory": return 4.2 + Math.min(4.8, degree * 0.78);
  }
}

function shapeCodeOf(node: MapNode): number {
  switch (node.kind) {
    case "core": return 1;
    case "branch": case "intel-hub": case "description": return 2;
    case "intel": return 3;
    case "objective": return 4;
    case "intel-overflow": return 5;
    default: return 0;
  }
}

function paletteKeyOf(node: MapNode): keyof MapPalette {
  switch (node.kind) {
    case "core": return "core";
    case "description": return "description";
    case "intel-hub": case "intel": case "intel-overflow": return "intel";
    case "source": return "source";
    case "objective": return "objective";
    case "branch": case "topic": case "memory":
      return node.branch === "person" || node.branch === "theater" || node.branch === "lessons" || node.branch === "crew"
        ? node.branch
        : "ink";
  }
}

function relativeLuminance(rgb: Rgb): number {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

const SECTOR_BRANCHES: readonly MapBranchKey[] = ["description", "theater", "lessons", "crew", "person", "intel"];
const FALLBACK_BRANCH_ANGLE: Record<MapBranchKey, number> = {
  description: Math.PI / 2,
  theater: Math.PI / 6,
  lessons: -Math.PI / 6,
  crew: -Math.PI / 2,
  person: (-5 * Math.PI) / 6,
  intel: (5 * Math.PI) / 6,
};

interface EdgeRecord {
  readonly a: number;
  readonly b: number;
  readonly baseAlpha: number;
  readonly baseWidth: number;
  readonly kind: "tree" | "link" | "objective" | "source";
  readonly isTrunk: boolean;
  readonly isBranch: boolean;
}

class MapWebglRendererImpl implements MapWebglRenderer {
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: WebGLRenderer | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV_DEG, 1, 1, 20000);

  private backdropGeo = new BufferGeometry();
  private backdropMat: ShaderMaterial | null = null;
  private backdropMesh: Mesh | null = null;

  private guideGeo = new BufferGeometry();
  private guideMat: ShaderMaterial | null = null;
  private guideLines: LineSegments | null = null;

  private dustGeo = new BufferGeometry();
  private dustMat: ShaderMaterial | null = null;
  private dustPoints: Points | null = null;

  private ribbonGeo = new BufferGeometry();
  private ribbonMat: ShaderMaterial | null = null;
  private ribbonMesh: Mesh | null = null;

  private pointGeo = new BufferGeometry();
  private pointMat: ShaderMaterial | null = null;
  private points: Points | null = null;
  private sortedIndices: Uint32Array = new Uint32Array(0);
  private depthScratch: Float32Array = new Float32Array(0);
  private indexBuf: BufferAttribute | null = null;

  private model: PositionedMapModel | null = null;
  private rgb: PaletteRgb | null = null;
  private light = false;
  private signature = "";
  private ids: string[] = [];
  private index = new Map<string, number>();
  private nodes: MapNode[] = [];
  private wx = new Float32Array(0);
  private wy = new Float32Array(0);
  private bx = new Float32Array(0);
  private by = new Float32Array(0);
  private stretchX = 1;
  private stretchY = 1;
  private uploaded = { sx: NaN, sy: NaN, sz: NaN };
  private baseCenter = new Vector3();
  private wz = new Float32Array(0);
  private z0 = new Float32Array(0);
  private zScale = 1;
  private radius = new Float32Array(0);
  private size = new Float32Array(0);
  private degree = new Int32Array(0);
  private edgeList: EdgeRecord[] = [];
  private coreIndex = -1;
  private center = new Vector3();
  private extent = 400;

  private filter: ReadonlySet<string> | null = null;
  private selection: string | null = null;
  private hover: string | null = null;
  private focus: Uint8Array | null = null;
  private focusId: string | null = null;

  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private insets: MapFitInsets = DEFAULT_INSETS;
  private fitDist = 1200;
  private zoom = 1;
  private readonly orient = new Quaternion();
  private readonly pan = new Vector3();
  private tween: { t0: number; dur: number; orient0: Quaternion; zoom0: number; pan0: Vector3 } | null = null;
  private drag: { id: number; x: number; y: number; active: boolean; pan: boolean } | null = null;

  private raf = 0;
  private dataDirty = true;
  private viewDirty = true;
  private depthDirty = true;
  private lastDraw = 0;
  private reducedMotion = false;
  private pulse = true;
  private disposed = false;
  private readonly tmp = new Vector3();
  private readonly viewListeners = new Set<() => void>();
  private lastView = "";
  private startTime = typeof performance !== "undefined" ? performance.now() : 0;

  private readonly onResize = () => this.resize();
  private readonly onContextLost = (event: Event) => { event.preventDefault(); };
  private readonly onContextRestored = () => { this.dataDirty = true; this.viewDirty = true; this.depthDirty = true; this.schedule(); };
  private readonly onContextMenu = (event: Event) => { event.preventDefault(); };
  private readonly onVisibility = () => {
    if (document.hidden) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else {
      this.viewDirty = true;
      this.schedule();
    }
  };
  private readonly onPointerDown = (event: PointerEvent) => {
    if ((event.button !== 0 && event.button !== 2) || this.drag) return;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false, pan: event.button === 2 || event.shiftKey };
  };
  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      this.tween = null;
      try { this.canvas?.setPointerCapture(event.pointerId); } catch { /* 캡처 실패는 끌기에 영향 없다 */ }
      if (this.canvas) this.canvas.style.cursor = "grabbing";
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.pan) {
      const perPx = (this.fitDist * this.zoom) / this.focalPx();
      const right = this.tmp.set(1, 0, 0).applyQuaternion(this.orient).multiplyScalar(-dx * perPx);
      this.pan.add(right);
      const up = this.tmp.set(0, 1, 0).applyQuaternion(this.orient).multiplyScalar(dy * perPx);
      this.pan.add(up);
      const limit = this.extent;
      this.pan.set(clamp(this.pan.x, -limit, limit), clamp(this.pan.y, -limit, limit), clamp(this.pan.z, -limit, limit));
    } else {
      this.rotateBy(-dx * DRAG_RAD_PER_PX, -dy * DRAG_RAD_PER_PX);
      this.depthDirty = true;
    }
    this.viewDirty = true;
    this.schedule();
  };
  private readonly onPointerEnd = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.drag = null;
    if (drag.active && this.canvas) {
      this.canvas.style.cursor = "";
      try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* 이미 풀렸다 */ }
    }
  };
  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.tween = null;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    this.zoom = clamp(this.zoom * Math.exp(event.deltaY * unit * 0.0012), ZOOM_MIN, ZOOM_MAX);
    this.viewDirty = true;
    this.schedule();
  };

  mount(container: HTMLElement, model: PositionedMapModel, palette: MapPalette): void {
    if (this.container) throw new Error("map-webgl: already mounted");
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true, antialias: true, depth: false, stencil: false, powerPreference: "high-performance",
    });
    if (!gl) throw new Error("map-webgl: webgl2 unavailable");
    try {
      const renderer = new WebGLRenderer({ canvas, context: gl, alpha: true, antialias: true, premultipliedAlpha: true });
      this.renderer = renderer;
      this.canvas = canvas;
      this.container = container;
      this.pixelRatio = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, MAX_PIXEL_RATIO);
      this.reducedMotion = prefersReducedMotion();
      this.pulse = !this.reducedMotion;
      renderer.setPixelRatio(this.pixelRatio);
      renderer.setClearColor(0x000000, 0);

      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;";
      canvas.addEventListener("webglcontextlost", this.onContextLost);
      canvas.addEventListener("webglcontextrestored", this.onContextRestored);
      canvas.addEventListener("contextmenu", this.onContextMenu);
      canvas.addEventListener("pointerdown", this.onPointerDown);
      canvas.addEventListener("pointermove", this.onPointerMove);
      canvas.addEventListener("pointerup", this.onPointerEnd);
      canvas.addEventListener("pointercancel", this.onPointerEnd);
      canvas.addEventListener("wheel", this.onWheel, { passive: false });
      document.addEventListener("visibilitychange", this.onVisibility);
      container.append(canvas);

      this.buildMaterials(renderer);
      this.applyModel(model, palette, true);
      this.resize();
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(container);
      this.schedule();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  update(model: PositionedMapModel, palette: MapPalette): void {
    if (!this.renderer || this.disposed) return;
    this.applyModel(model, palette, false);
    this.schedule();
  }

  setSelection(id: string | null): void {
    if (this.selection === id) return;
    this.selection = id;
    if (this.hover !== null && this.hover !== id) this.hover = null;
    this.updateFocus();
    this.dataDirty = true;
    this.schedule();
  }

  setHover(id: string | null): void {
    if (this.hover === id) return;
    this.hover = id;
    this.updateFocus();
    this.dataDirty = true;
    this.schedule();
  }

  setFilter(visible: ReadonlySet<string>): void {
    this.filter = visible;
    this.updateFocus();
    this.dataDirty = true;
    this.schedule();
  }

  setFitInsets(insets: MapFitInsets): void {
    const current = this.insets;
    if (
      insets.top === current.top
      && insets.right === current.right
      && insets.bottom === current.bottom
      && insets.left === current.left
    ) return;
    this.insets = insets;
    this.resize(true);
    this.schedule();
  }

  setReducedMotion(reduced: boolean): void {
    if (this.reducedMotion === reduced) return;
    this.reducedMotion = reduced;
    this.pulse = !reduced;
    if (reduced && this.tween) {
      this.orient.identity();
      this.zoom = 1;
      this.pan.set(0, 0, 0);
      this.tween = null;
      this.depthDirty = true;
    }
    this.viewDirty = true;
    this.schedule();
  }

  pick(x: number, y: number): string | null {
    if (!this.renderer || this.width === 0) return null;
    this.camera.updateMatrixWorld();
    let best: string | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < this.ids.length; i += 1) {
      const projected = this.screenOf(i);
      if (!projected) continue;
      const radius = this.visibleRadiusPx(i, projected.depth);
      const hit = Math.max(radius + 2, MIN_HIT_PX);
      const distance = Math.hypot(projected.x - x, projected.y - y);
      if (distance > hit) continue;
      const score = distance + radius * 0.001;
      if (score < bestScore) { bestScore = score; best = this.ids[i]!; }
    }
    return best;
  }

  project(id: string): { readonly x: number; readonly y: number; readonly visible: boolean } | null {
    const i = this.index.get(id);
    if (i === undefined || !this.renderer) return null;
    this.camera.updateMatrixWorld();
    const v = this.tmp.set(this.wx[i]!, this.wy[i]!, this.wz[i]!).applyMatrix4(this.camera.matrixWorldInverse);
    const depth = -v.z;
    v.applyMatrix4(this.camera.projectionMatrix);
    const x = (v.x + 1) / 2 * this.width;
    const y = (1 - v.y) / 2 * this.height;
    const inside = depth > this.camera.near && x >= 0 && x <= this.width && y >= 0 && y <= this.height;
    return { x, y, visible: inside && this.isVisible(id) };
  }

  fit(): void {
    if (!this.renderer) return;
    if (this.reducedMotion) {
      this.orient.identity();
      this.zoom = 1;
      this.pan.set(0, 0, 0);
      this.tween = null;
      this.viewDirty = true;
      this.depthDirty = true;
    } else {
      this.tween = {
        t0: performance.now(), dur: FIT_TWEEN_MS,
        orient0: this.orient.clone(), zoom0: this.zoom, pan0: this.pan.clone(),
      };
    }
    this.placeCamera();
    this.schedule();
  }

  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => { this.viewListeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.viewListeners.clear();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    const canvas = this.canvas;
    if (canvas) {
      canvas.removeEventListener("webglcontextlost", this.onContextLost);
      canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
      canvas.removeEventListener("contextmenu", this.onContextMenu);
      canvas.removeEventListener("pointerdown", this.onPointerDown);
      canvas.removeEventListener("pointermove", this.onPointerMove);
      canvas.removeEventListener("pointerup", this.onPointerEnd);
      canvas.removeEventListener("pointercancel", this.onPointerEnd);
      canvas.removeEventListener("wheel", this.onWheel);
    }
    this.drag = null;
    this.backdropGeo.dispose();
    this.backdropMat?.dispose();
    this.guideGeo.dispose();
    this.guideMat?.dispose();
    this.dustGeo.dispose();
    this.dustMat?.dispose();
    this.ribbonGeo.dispose();
    this.ribbonMat?.dispose();
    this.pointGeo.dispose();
    this.pointMat?.dispose();
    const renderer = this.renderer;
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
    canvas?.remove();
    this.renderer = null;
    this.canvas = null;
    this.container = null;
    this.model = null;
    this.filter = null;
  }

  // ── 머티리얼 & 모델 ──────────────────────────────────────────────────────────

  private buildMaterials(renderer: WebGLRenderer): void {
    const maxPoint = (renderer.getContext().getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE) as Float32Array)[1] ?? 64;
    this.backdropMat = new ShaderMaterial({
      uniforms: {
        uRadius: { value: 420 },
        uLight: { value: 0 },
        uFocusDim: { value: 0 },
        uTime: { value: 0 },
        uMotion: { value: 1 },
        uCoreRgb: { value: new Vector3(0.55, 0.83, 0.81) },
        uBranchRgb: { value: Array.from({ length: 6 }, () => new Vector3(0.6, 0.7, 0.8)) },
        uBranchAngle: { value: new Float32Array(6) },
        uBranchActive: { value: new Float32Array(6) },
      },
      vertexShader: BACKDROP_PLANE_VERTEX,
      fragmentShader: BACKDROP_PLANE_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, side: DoubleSide, blending: NormalBlending,
    });
    this.guideMat = new ShaderMaterial({
      uniforms: {
        uColor: { value: new Vector3(0.5, 0.54, 0.6) },
        uFocusDim: { value: 0 },
      },
      vertexShader: GUIDE_VERTEX,
      fragmentShader: GUIDE_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, blending: NormalBlending,
    });
    this.dustMat = new ShaderMaterial({
      uniforms: {
        uColor: { value: new Vector3(0.84, 0.90, 0.96) },
        uLight: { value: 0 },
        uPixelRatio: { value: this.pixelRatio },
        uTime: { value: 0 },
        uMotion: { value: 1 },
      },
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, blending: NormalBlending,
    });
    this.ribbonMat = new ShaderMaterial({
      uniforms: {
        uResolution: { value: new Vector2(800, 600) },
        uTime: { value: 0 },
        uMotion: { value: 1 },
        uLight: { value: 0 },
        uFreshRgb: { value: new Vector3(0.47, 0.79, 0.83) },
      },
      vertexShader: RIBBON_VERTEX,
      fragmentShader: RIBBON_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, side: DoubleSide, blending: NormalBlending,
    });
    this.pointMat = new ShaderMaterial({
      uniforms: {
        uScale: { value: 1 },
        uFocus: { value: 1200 },
        uRange: { value: 360 },
        uMaxPx: { value: Math.min(MAX_SPRITE_CSS * this.pixelRatio, maxPoint) },
        uLight: { value: 0 },
        uTime: { value: 0 },
        uMotion: { value: 1 },
        uFreshRgb: { value: new Vector3(0.47, 0.79, 0.83) },
        uStaleRgb: { value: new Vector3(0.86, 0.70, 0.36) },
        uInkRgb: { value: new Vector3(0.95, 0.95, 0.95) },
        uStageRgb: { value: new Vector3(0.08, 0.09, 0.11) },
      },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, blending: NormalBlending,
    });
  }

  private applyModel(model: PositionedMapModel, palette: MapPalette, first: boolean): void {
    const previous = this.model;
    this.model = model;
    this.rgb = mapPaletteToRgb(palette);
    const light = relativeLuminance(this.rgb.ink) < 0.45;
    if (light !== this.light || first) this.light = light;
    if (!previous || previous.graph !== model.graph || previous.layout !== model.layout) this.rebuild(model);
    this.dataDirty = true;
    this.depthDirty = true;
  }

  private rebuild(model: PositionedMapModel): void {
    const { graph, layout } = model;
    const nodes = graph.nodes.filter((node) => layout.positions.has(node.id));
    this.nodes = nodes;
    this.ids = nodes.map((node) => node.id);
    this.index = new Map(this.ids.map((id, i) => [id, i] as const));
    const n = nodes.length;
    this.wx = new Float32Array(n);
    this.wy = new Float32Array(n);
    this.bx = new Float32Array(n);
    this.by = new Float32Array(n);
    this.wz = new Float32Array(n);
    this.z0 = new Float32Array(n);
    this.radius = new Float32Array(n);
    this.size = new Float32Array(n);
    this.degree = new Int32Array(n);
    this.coreIndex = nodes.findIndex((node) => node.kind === "core");
    nodes.forEach((node, i) => {
      const p = layout.positions.get(node.id)!;
      this.bx[i] = p.x * WORLD_SCALE;
      this.by[i] = -p.y * WORLD_SCALE;
      this.z0[i] = depthOf(node);
      this.wz[i] = this.z0[i]! * this.zScale;
    });

    this.edgeList = [];
    for (const edge of graph.edges) {
      const a = this.index.get(edge.from);
      const b = this.index.get(edge.to);
      if (a === undefined || b === undefined) continue;
      this.degree[a]! += 1;
      this.degree[b]! += 1;
      const isTrunk = nodes[a]!.kind === "core";
      const isBranch = nodes[b]!.kind === "topic" || nodes[b]!.kind === "source";
      let baseAlpha = 0.28;
      let baseWidth = 0.9;
      if (edge.kind === "link") { baseAlpha = 0.56; baseWidth = 1.4; }
      else if (edge.kind === "objective" || edge.kind === "source") { baseAlpha = 0.18; baseWidth = 0.9; }
      else if (isTrunk) { baseAlpha = 0.64; baseWidth = 2.25; }
      else if (isBranch) { baseAlpha = 0.44; baseWidth = 1.3; }
      this.edgeList.push({ a, b, baseAlpha, baseWidth, kind: edge.kind, isTrunk, isBranch });
    }
    nodes.forEach((node, i) => { this.radius[i] = radiusOf(node, this.degree[i]!); });
    const { minX, maxX, minY, maxY } = layout.bounds;
    this.baseCenter.set(((minX + maxX) / 2) * WORLD_SCALE, -((minY + maxY) / 2) * WORLD_SCALE, 0);
    this.applyShape(this.stretchX, this.stretchY, this.zScale, false);

    // 1) Point geometry (depth-sorted index buffer)
    const dynamic = (array: Float32Array, itemSize: number) => new BufferAttribute(array, itemSize).setUsage(DynamicDrawUsage);
    const pointGeo = new BufferGeometry();
    const position = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) { position[i * 3] = this.wx[i]!; position[i * 3 + 1] = this.wy[i]!; position[i * 3 + 2] = this.wz[i]!; }
    pointGeo.setAttribute("position", new BufferAttribute(position, 3));
    pointGeo.setAttribute("aColor", dynamic(new Float32Array(n * 3), 3));
    pointGeo.setAttribute("aSize", dynamic(new Float32Array(n), 1));
    pointGeo.setAttribute("aAlpha", dynamic(new Float32Array(n), 1));
    const shape = new Float32Array(n);
    nodes.forEach((node, i) => { shape[i] = shapeCodeOf(node); });
    pointGeo.setAttribute("aShape", new BufferAttribute(shape, 1));
    pointGeo.setAttribute("aFresh", dynamic(new Float32Array(n), 1));
    pointGeo.setAttribute("aStale", dynamic(new Float32Array(n), 1));
    pointGeo.setAttribute("aActive", dynamic(new Float32Array(n), 1));
    this.sortedIndices = new Uint32Array(n);
    this.depthScratch = new Float32Array(n);
    for (let i = 0; i < n; i += 1) this.sortedIndices[i] = i;
    this.indexBuf = new BufferAttribute(this.sortedIndices, 1).setUsage(DynamicDrawUsage);
    pointGeo.setIndex(this.indexBuf);

    // 2) Curved synaptic ribbon geometry (1 draw call for every edge)
    const m = this.edgeList.length;
    const vertsPerEdge = (EDGE_SEGMENTS + 1) * 2;
    const trisPerEdge = EDGE_SEGMENTS * 6;
    const totalVerts = m * vertsPerEdge;
    const ribbonGeo = new BufferGeometry();
    ribbonGeo.setAttribute("position", dynamic(new Float32Array(totalVerts * 3), 3));
    ribbonGeo.setAttribute("aTangent", dynamic(new Float32Array(totalVerts * 3), 3));
    const rSide = new Float32Array(totalVerts);
    const rU = new Float32Array(totalVerts);
    const rPhase = new Float32Array(totalVerts);
    const rDash = new Float32Array(totalVerts);
    for (let e = 0; e < m; e += 1) {
      const edge = this.edgeList[e]!;
      const dash = (edge.kind === "objective" || edge.kind === "source") ? 1 : 0;
      const phase = ((e * 0.371) % 1);
      const vBase = e * vertsPerEdge;
      for (let s = 0; s <= EDGE_SEGMENTS; s += 1) {
        const u = s / EDGE_SEGMENTS;
        const v0 = vBase + s * 2;
        rSide[v0] = -1; rSide[v0 + 1] = 1;
        rU[v0] = u; rU[v0 + 1] = u;
        rPhase[v0] = phase; rPhase[v0 + 1] = phase;
        rDash[v0] = dash; rDash[v0 + 1] = dash;
      }
    }
    ribbonGeo.setAttribute("aSide", new BufferAttribute(rSide, 1));
    ribbonGeo.setAttribute("aU", new BufferAttribute(rU, 1));
    ribbonGeo.setAttribute("aDist", dynamic(new Float32Array(totalVerts), 1));
    ribbonGeo.setAttribute("aWidth", dynamic(new Float32Array(totalVerts), 1));
    ribbonGeo.setAttribute("aAlpha", dynamic(new Float32Array(totalVerts), 1));
    ribbonGeo.setAttribute("aDash", new BufferAttribute(rDash, 1));
    ribbonGeo.setAttribute("aPulse", dynamic(new Float32Array(totalVerts), 1));
    ribbonGeo.setAttribute("aPhase", new BufferAttribute(rPhase, 1));
    ribbonGeo.setAttribute("aColorA", dynamic(new Float32Array(totalVerts * 3), 3));
    ribbonGeo.setAttribute("aColorB", dynamic(new Float32Array(totalVerts * 3), 3));

    const rIdx = new Uint32Array(m * trisPerEdge);
    for (let e = 0; e < m; e += 1) {
      const vBase = e * vertsPerEdge;
      const iBase = e * trisPerEdge;
      for (let s = 0; s < EDGE_SEGMENTS; s += 1) {
        const a = vBase + s * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        const o = iBase + s * 6;
        rIdx[o] = a; rIdx[o + 1] = b; rIdx[o + 2] = c;
        rIdx[o + 3] = b; rIdx[o + 4] = d; rIdx[o + 5] = c;
      }
    }
    ribbonGeo.setIndex(new BufferAttribute(rIdx, 1));

    // Swap scene meshes
    if (this.points) this.scene.remove(this.points);
    if (this.ribbonMesh) this.scene.remove(this.ribbonMesh);
    this.pointGeo.dispose();
    this.ribbonGeo.dispose();
    this.pointGeo = pointGeo;
    this.ribbonGeo = ribbonGeo;
    this.ribbonMesh = new Mesh(ribbonGeo, this.ribbonMat!);
    this.points = new Points(pointGeo, this.pointMat!);
    this.ribbonMesh.frustumCulled = false;
    this.points.frustumCulled = false;
    this.ribbonMesh.renderOrder = 2;
    this.points.renderOrder = 3;
    this.scene.add(this.ribbonMesh, this.points);
    this.uploaded = { sx: NaN, sy: NaN, sz: NaN };

    this.updateFocus();
    const signature = this.ids.join("\n");
    if (signature !== this.signature) {
      this.signature = signature;
      this.orient.identity(); this.zoom = 1; this.pan.set(0, 0, 0); this.tween = null;
    }
    this.computeFit();
    this.rebuildSpatialGuides();
  }

  /** Layer 0 (성도 극좌표 눈금 · 6갈래 구역 틴트 평면 · 다크 심도 성진)을 현재 extent 기준으로 생성. */
  private rebuildSpatialGuides(): void {
    const coreX = this.coreIndex >= 0 ? this.wx[this.coreIndex]! : this.center.x;
    const coreY = this.coreIndex >= 0 ? this.wy[this.coreIndex]! : this.center.y;
    const guideR = Math.max(180, this.extent * 1.02);

    // 1) Sector + core aura plane at z = -4
    const half = guideR * 1.3;
    const planePos = new Float32Array([
      -half, -half, 0, half, -half, 0, half, half, 0,
      -half, -half, 0, half, half, 0, -half, half, 0,
    ]);
    const backdropGeo = new BufferGeometry();
    backdropGeo.setAttribute("position", new BufferAttribute(planePos, 3));
    if (this.backdropMesh) this.scene.remove(this.backdropMesh);
    this.backdropGeo.dispose();
    this.backdropGeo = backdropGeo;
    this.backdropMesh = new Mesh(backdropGeo, this.backdropMat!);
    this.backdropMesh.position.set(coreX, coreY, -4);
    this.backdropMesh.frustumCulled = false;
    this.backdropMesh.renderOrder = 0;
    this.scene.add(this.backdropMesh);
    if (this.backdropMat) this.backdropMat.uniforms.uRadius!.value = guideR;

    // 2) Calibrated polar rings + 36 compass ticks + subtle crosshairs
    const segPos: number[] = [];
    const segAlpha: number[] = [];
    const pushSeg = (x0: number, y0: number, x1: number, y1: number, a: number) => {
      segPos.push(x0, y0, -2, x1, y1, -2);
      segAlpha.push(a, a);
    };
    const ringSpecs = [
      { frac: 0.32, steps: 72, dashed: false, alpha: 0.14 },
      { frac: 0.64, steps: 96, dashed: true, alpha: 0.13 },
      { frac: 0.94, steps: 120, dashed: false, alpha: 0.20 },
    ];
    for (const ring of ringSpecs) {
      const rr = guideR * ring.frac;
      for (let i = 0; i < ring.steps; i += 1) {
        if (ring.dashed && i % 2 === 1) continue;
        const a0 = (i / ring.steps) * Math.PI * 2;
        const a1 = ((i + 1) / ring.steps) * Math.PI * 2;
        pushSeg(
          coreX + Math.cos(a0) * rr, coreY + Math.sin(a0) * rr,
          coreX + Math.cos(a1) * rr, coreY + Math.sin(a1) * rr,
          ring.alpha,
        );
      }
    }
    // 36 compass ticks along outer calibrated ring
    const tickOuter = guideR * 0.965;
    for (let i = 0; i < 36; i += 1) {
      const a = (i / 36) * Math.PI * 2;
      const major = i % 3 === 0;
      const rIn = guideR * (major ? 0.90 : 0.922);
      pushSeg(
        coreX + Math.cos(a) * rIn, coreY + Math.sin(a) * rIn,
        coreX + Math.cos(a) * tickOuter, coreY + Math.sin(a) * tickOuter,
        major ? 0.28 : 0.15,
      );
    }
    // Delicate orthogonal crosshairs
    const axisSpan = guideR * 1.04;
    pushSeg(coreX - axisSpan, coreY, coreX + axisSpan, coreY, 0.085);
    pushSeg(coreX, coreY - axisSpan, coreX, coreY + axisSpan, 0.085);

    const guideGeo = new BufferGeometry();
    guideGeo.setAttribute("position", new BufferAttribute(new Float32Array(segPos), 3));
    guideGeo.setAttribute("aAlpha", new BufferAttribute(new Float32Array(segAlpha), 1));
    if (this.guideLines) this.scene.remove(this.guideLines);
    this.guideGeo.dispose();
    this.guideGeo = guideGeo;
    this.guideLines = new LineSegments(guideGeo, this.guideMat!);
    this.guideLines.frustumCulled = false;
    this.guideLines.renderOrder = 1;
    this.scene.add(this.guideLines);

    // 3) Subtle 3D dust cloud for dark parallax
    const dustCount = 64;
    const rand = rng32(20261121);
    const dustPos = new Float32Array(dustCount * 3);
    const dustPhase = new Float32Array(dustCount);
    const dustSize = new Float32Array(dustCount);
    const dustR = guideR * 1.45;
    for (let i = 0; i < dustCount; i += 1) {
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      const rad = dustR * (0.45 + 0.65 * Math.cbrt(rand()));
      dustPos[i * 3] = coreX + rad * Math.sin(phi) * Math.cos(theta);
      dustPos[i * 3 + 1] = coreY + rad * Math.sin(phi) * Math.sin(theta);
      dustPos[i * 3 + 2] = rad * Math.cos(phi) * 0.65;
      dustPhase[i] = rand() * Math.PI * 2;
      dustSize[i] = 1.6 + rand() * 1.5;
    }
    const dustGeo = new BufferGeometry();
    dustGeo.setAttribute("position", new BufferAttribute(dustPos, 3));
    dustGeo.setAttribute("aPhase", new BufferAttribute(dustPhase, 1));
    dustGeo.setAttribute("aSize", new BufferAttribute(dustSize, 1));
    if (this.dustPoints) this.scene.remove(this.dustPoints);
    this.dustGeo.dispose();
    this.dustGeo = dustGeo;
    this.dustPoints = new Points(dustGeo, this.dustMat!);
    this.dustPoints.frustumCulled = false;
    this.dustPoints.renderOrder = 1;
    this.scene.add(this.dustPoints);
  }

  private updateFocus(): void {
    const hover = this.hover !== null && this.isVisible(this.hover) ? this.hover : null;
    const selection = this.selection !== null && this.isVisible(this.selection) ? this.selection : null;
    const id = hover ?? selection;
    const i = id !== null ? this.index.get(id) : undefined;
    if (i === undefined || id === null) { this.focus = null; this.focusId = null; return; }
    this.focusId = id;
    const flags = new Uint8Array(this.nodes.length);
    flags[i] = 1;
    for (const other of this.model?.graph.adjacent.get(id) ?? []) {
      const j = this.index.get(other);
      if (j !== undefined) flags[j] = 1;
    }
    this.focus = flags;
  }

  private isVisible(id: string): boolean {
    return this.filter === null || this.filter.has(id) || id === "core";
  }

  // ── 크기·카메라 ────────────────────────────────────────────────────────────

  private focalPx(): number {
    return (this.height / 2) / Math.tan((FOV_DEG * Math.PI) / 360);
  }

  private resize(force = false): void {
    const container = this.container;
    const renderer = this.renderer;
    if (!container || !renderer) return;
    const w = Math.max(1, Math.round(container.clientWidth));
    const h = Math.max(1, Math.round(container.clientHeight));
    if (!force && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    if (this.ribbonMat) (this.ribbonMat.uniforms.uResolution!.value as Vector2).set(w, h);
    this.computeFit();
    this.rebuildSpatialGuides();
    this.dataDirty = true;
    this.viewDirty = true;
    this.depthDirty = true;
    this.schedule();
  }

  private computeFit(): void {
    const { width, height } = this;
    if (width === 0 || height === 0 || this.nodes.length === 0) return;
    // 부유 인스펙터가 한쪽을 넓게 차지해도(예: 640px 무대의 316px 패널) 최소 160px 가용 폭만 보장하고
    // 우측 여백을 그대로 반영해 그래프 중심·맞춤 보기가 패널 아래로 숨지 않게 한다.
    const rawLeft = Math.max(0, this.insets.left);
    const rawRight = Math.max(0, this.insets.right);
    const maxSumX = Math.max(0, width - Math.min(width, 160));
    const sumX = rawLeft + rawRight;
    const scaleX = sumX > maxSumX && sumX > 0 ? maxSumX / sumX : 1;
    const capY = (value: number) => Math.max(0, Math.min(value, height * 0.2));
    const insets = {
      top: capY(this.insets.top), bottom: capY(this.insets.bottom),
      left: rawLeft * scaleX, right: rawRight * scaleX,
    };
    const availW = Math.max(40, width - insets.left - insets.right);
    const availH = Math.max(40, height - insets.top - insets.bottom);
    const f = this.focalPx();
    let halfW = 1;
    let halfH = 1;
    for (let i = 0; i < this.nodes.length; i += 1) {
      halfW = Math.max(halfW, Math.abs(this.bx[i]! - this.baseCenter.x) + this.radius[i]!);
      halfH = Math.max(halfH, Math.abs(this.by[i]! - this.baseCenter.y) + this.radius[i]!);
    }
    const want = availW / availH / (halfW / halfH);
    const sx = want > 1 ? Math.min(want, STRETCH_MAX) : 1;
    const sy = want < 1 ? Math.min(1 / want, STRETCH_MAX) : 1;
    this.applyShape(sx, sy, this.zScale, false);
    let reach = 1;
    let flat = 1;
    for (let i = 0; i < this.nodes.length; i += 1) {
      const dx = (Math.abs(this.wx[i]! - this.center.x) + this.radius[i]!) * FIT_MARGIN;
      const dy = (Math.abs(this.wy[i]! - this.center.y) + this.radius[i]!) * FIT_MARGIN;
      reach = Math.max(reach, Math.hypot(dx, dy));
      flat = Math.max(flat, (dx * f) / (availW / 2), (dy * f) / (availH / 2));
    }
    const refDist = reach / Math.tan((FOV_DEG * Math.PI) / 360);
    this.applyShape(sx, sy, clamp(flat / refDist, 1, Z_SCALE_MAX), true);
    let dist = 1;
    let extent = 1;
    for (let i = 0; i < this.nodes.length; i += 1) {
      const rim = this.radius[i]!;
      const dx = (Math.abs(this.wx[i]! - this.center.x) + rim) * FIT_MARGIN;
      const dy = (Math.abs(this.wy[i]! - this.center.y) + rim) * FIT_MARGIN;
      extent = Math.max(extent, dx, dy);
      dist = Math.max(dist, this.wz[i]! + (dx * f) / (availW / 2), this.wz[i]! + (dy * f) / (availH / 2));
    }
    this.fitDist = dist;
    this.extent = extent;
    const shiftX = (insets.left - insets.right) / 2;
    const shiftY = (insets.top - insets.bottom) / 2;
    if (Math.abs(shiftX) < 0.5 && Math.abs(shiftY) < 0.5) {
      this.camera.clearViewOffset();
    } else {
      this.camera.setViewOffset(width, height, -shiftX, -shiftY, width, height);
    }
    this.camera.updateProjectionMatrix();
    this.placeCamera();
  }

  private applyShape(sx: number, sy: number, sz: number, upload: boolean): void {
    this.stretchX = sx;
    this.stretchY = sy;
    this.zScale = sz;
    this.center.set(this.baseCenter.x, this.baseCenter.y, 0);
    const n = this.wx.length;
    for (let i = 0; i < n; i += 1) {
      this.wx[i] = this.baseCenter.x + (this.bx[i]! - this.baseCenter.x) * sx;
      this.wy[i] = this.baseCenter.y + (this.by[i]! - this.baseCenter.y) * sy;
      this.wz[i] = this.z0[i]! * sz;
    }
    if (!upload) return;
    const up = this.uploaded;
    if (Math.abs(sx - up.sx) < 1e-3 && Math.abs(sy - up.sy) < 1e-3 && Math.abs(sz - up.sz) < 1e-3) return;
    this.uploaded = { sx, sy, sz };

    const position = this.pointGeo.getAttribute("position") as BufferAttribute | undefined;
    if (position) {
      for (let i = 0; i < n; i += 1) position.setXYZ(i, this.wx[i]!, this.wy[i]!, this.wz[i]!);
      position.needsUpdate = true;
    }
    this.uploadRibbonGeometry();
    this.depthDirty = true;
  }

  /** 모든 엣지의 2차 베지에 곡선 정점·접선·누적 거리를 업로드한다. */
  private uploadRibbonGeometry(): void {
    const posAttr = this.ribbonGeo.getAttribute("position") as BufferAttribute | undefined;
    const tanAttr = this.ribbonGeo.getAttribute("aTangent") as BufferAttribute | undefined;
    const distAttr = this.ribbonGeo.getAttribute("aDist") as BufferAttribute | undefined;
    if (!posAttr || !tanAttr || !distAttr) return;

    const coreX = this.coreIndex >= 0 ? this.wx[this.coreIndex]! : this.center.x;
    const coreY = this.coreIndex >= 0 ? this.wy[this.coreIndex]! : this.center.y;
    const vertsPerEdge = (EDGE_SEGMENTS + 1) * 2;

    for (let e = 0; e < this.edgeList.length; e += 1) {
      const edge = this.edgeList[e]!;
      const x0 = this.wx[edge.a]!, y0 = this.wy[edge.a]!, z0 = this.wz[edge.a]!;
      const x1 = this.wx[edge.b]!, y1 = this.wy[edge.b]!, z1 = this.wz[edge.b]!;
      const mx = (x0 + x1) * 0.5;
      const my = (y0 + y1) * 0.5;
      const mz = (z0 + z1) * 0.5;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const dir = (e % 2 === 0) ? 1 : -1;

      let cx = mx;
      let cy = my;
      let cz = mz;
      if (edge.kind === "link") {
        const bend = Math.min(82, len * 0.22) * dir;
        cx = mx + nx * bend;
        cy = my + ny * bend;
        cz = mz + Math.min(95, len * 0.2);
      } else if (edge.isTrunk) {
        const bend = Math.min(28, len * 0.10) * dir;
        cx = mx + nx * bend;
        cy = my + ny * bend;
      } else if (edge.kind === "objective" || edge.kind === "source") {
        const bend = Math.min(24, len * 0.06) * dir;
        cx = mx + nx * bend;
        cy = my + ny * bend;
      } else {
        cx = mx + (coreX - mx) * 0.12 + nx * 9 * dir;
        cy = my + (coreY - my) * 0.12 + ny * 9 * dir;
      }

      const vBase = e * vertsPerEdge;
      let prevX = x0;
      let prevY = y0;
      let prevZ = z0;
      let cumDist = 0;
      for (let s = 0; s <= EDGE_SEGMENTS; s += 1) {
        const u = s / EDGE_SEGMENTS;
        const iu = 1 - u;
        const px = iu * iu * x0 + 2 * iu * u * cx + u * u * x1;
        const py = iu * iu * y0 + 2 * iu * u * cy + u * u * y1;
        const pz = iu * iu * z0 + 2 * iu * u * cz + u * u * z1;
        const tx = 2 * iu * (cx - x0) + 2 * u * (x1 - cx);
        const ty = 2 * iu * (cy - y0) + 2 * u * (y1 - cy);
        const tz = 2 * iu * (cz - z0) + 2 * u * (z1 - cz);
        if (s > 0) cumDist += Math.hypot(px - prevX, py - prevY, pz - prevZ);
        prevX = px; prevY = py; prevZ = pz;
        const v0 = vBase + s * 2;
        posAttr.setXYZ(v0, px, py, pz);
        posAttr.setXYZ(v0 + 1, px, py, pz);
        tanAttr.setXYZ(v0, tx, ty, tz);
        tanAttr.setXYZ(v0 + 1, tx, ty, tz);
        distAttr.setX(v0, cumDist);
        distAttr.setX(v0 + 1, cumDist);
      }
    }
    posAttr.needsUpdate = true;
    tanAttr.needsUpdate = true;
    distAttr.needsUpdate = true;
  }

  private rotateBy(yaw: number, pitch: number): void {
    const step = new Quaternion().setFromAxisAngle(this.tmp.set(0, 1, 0), yaw);
    this.orient.multiply(step);
    step.setFromAxisAngle(this.tmp.set(1, 0, 0), pitch);
    this.orient.multiply(step).normalize();
  }

  private placeCamera(): void {
    const dist = this.fitDist * this.zoom;
    const target = this.tmp.set(this.center.x + this.pan.x, this.center.y + this.pan.y, this.pan.z);
    this.camera.quaternion.copy(this.orient);
    this.camera.position.set(0, 0, dist).applyQuaternion(this.orient).add(target);
    this.camera.up.set(0, 1, 0).applyQuaternion(this.orient);
    this.camera.updateMatrixWorld();
  }

  /** NormalBlending에서 가까운 점이 뒤에 가리지 않게 카메라 깊이 순으로 인덱스만 정렬한다. */
  private sortPointsByDepth(): void {
    const n = this.nodes.length;
    if (n <= 1 || !this.indexBuf) return;
    const e = this.camera.matrixWorldInverse.elements;
    const m2 = e[2]!, m6 = e[6]!, m10 = e[10]!, m14 = e[14]!;
    const depths = this.depthScratch;
    for (let i = 0; i < n; i += 1) {
      depths[i] = -(m2 * this.wx[i]! + m6 * this.wy[i]! + m10 * this.wz[i]! + m14);
    }
    // 깊은(큰 depth) 점부터 먼저 그린다.
    this.sortedIndices.sort((a, b) => depths[b]! - depths[a]!);
    this.indexBuf.needsUpdate = true;
  }

  // ── 점 크기·고르기 ─────────────────────────────────────────────────────────

  private screenOf(i: number): { x: number; y: number; depth: number } | null {
    if (!this.isVisible(this.ids[i]!)) return null;
    const v = this.tmp.set(this.wx[i]!, this.wy[i]!, this.wz[i]!).applyMatrix4(this.camera.matrixWorldInverse);
    const depth = -v.z;
    if (depth <= this.camera.near) return null;
    v.applyMatrix4(this.camera.projectionMatrix);
    return { x: (v.x + 1) / 2 * this.width, y: (1 - v.y) / 2 * this.height, depth };
  }

  private focusRange(): number {
    return Math.max(FOCUS_RANGE_MIN, this.fitDist * this.zoom * FOCUS_RANGE_RATIO);
  }

  private visibleRadiusPx(i: number, depth: number): number {
    const coc = clamp(Math.abs(depth - this.fitDist * this.zoom) / this.focusRange(), 0, 1);
    const sprite = Math.min(this.size[i]! * SPRITE_K * this.focalPx() / depth * (1 + coc * 0.14), MAX_SPRITE_CSS);
    return (sprite * 0.5) * BODY_NORM_R;
  }

  private baseSize(i: number): number {
    const node = this.nodes[i]!;
    const crowd = clamp((this.nodes.length - CROWD_FROM) / (CROWD_TO - CROWD_FROM), 0, 1);
    const crowdScale = node.kind === "core" ? 1 : lerp(1, 0.84, crowd);
    let s = this.radius[i]! * crowdScale * (node.kind === "topic" ? 0.84 : 1);
    if (node.id === this.hover || node.id === this.selection) s *= 1.32;
    return s;
  }

  // ── 그리기 ─────────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.raf || this.disposed || !this.renderer || (typeof document !== "undefined" && document.hidden)) return;
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  private frame(now: number): void {
    this.raf = 0;
    const renderer = this.renderer;
    if (!renderer || this.disposed || !this.rgb) return;

    const tween = this.tween;
    if (tween) {
      const t = clamp((now - tween.t0) / tween.dur, 0, 1);
      const e = easeInOut(t);
      this.orient.slerpQuaternions(tween.orient0, IDENTITY, e);
      this.zoom = lerp(tween.zoom0, 1, e);
      this.pan.copy(tween.pan0).multiplyScalar(1 - e);
      if (t >= 1) this.tween = null;
      this.viewDirty = true;
      this.depthDirty = true;
    }

    const changed = this.dataDirty || this.viewDirty;
    if (changed || (this.pulse && now - this.lastDraw >= PULSE_FRAME_MS)) {
      this.lastDraw = now;
      if (this.dataDirty) { this.writeBuffers(); this.dataDirty = false; }
      this.writePulse(now);
      this.viewDirty = false;
      this.placeCamera();
      if (this.depthDirty) { this.sortPointsByDepth(); this.depthDirty = false; }
      this.writeUniforms(now);
      renderer.render(this.scene, this.camera);
      this.notifyView();
    }
    if (this.pulse || this.tween) this.schedule();
  }

  private notifyView(): void {
    const o = this.orient;
    const signature = [o.x, o.y, o.z, o.w, this.zoom, this.pan.x, this.pan.y, this.pan.z, this.width, this.height, this.fitDist]
      .map((v) => v.toFixed(4)).join(",");
    if (signature === this.lastView) return;
    this.lastView = signature;
    for (const listener of this.viewListeners) {
      try { listener(); } catch { /* DOM 동기 실패는 다음 그림으로 미룬다 */ }
    }
  }

  private writeUniforms(now: number): void {
    const rgb = this.rgb;
    if (!rgb) return;
    const tSec = (now - this.startTime) * 0.001;
    const lightFlag = this.light ? 1 : 0;
    const motionFlag = this.pulse ? 1 : 0;
    const focusDim = this.focus ? 1 : 0;

    if (this.backdropMat) {
      const u = this.backdropMat.uniforms;
      u.uLight!.value = lightFlag;
      u.uFocusDim!.value = focusDim;
      u.uTime!.value = tSec;
      u.uMotion!.value = motionFlag;
      (u.uCoreRgb!.value as Vector3).set(rgb.core[0] / 255, rgb.core[1] / 255, rgb.core[2] / 255);
      const bRgb = u.uBranchRgb!.value as Vector3[];
      const bAng = u.uBranchAngle!.value as Float32Array;
      const bAct = u.uBranchActive!.value as Float32Array;
      const coreX = this.coreIndex >= 0 ? this.wx[this.coreIndex]! : this.center.x;
      const coreY = this.coreIndex >= 0 ? this.wy[this.coreIndex]! : this.center.y;
      SECTOR_BRANCHES.forEach((branch, idx) => {
        const hubId = branch === "description" ? "desc" : branch === "intel" ? "intel" : `mem:${branch}`;
        const hi = this.index.get(hubId);
        const c = branch === "description" ? rgb.core : rgb[branch];
        bRgb[idx]!.set(c[0] / 255, c[1] / 255, c[2] / 255);
        if (hi !== undefined && this.isVisible(hubId)) {
          bAng[idx] = Math.atan2(this.wy[hi]! - coreY, this.wx[hi]! - coreX);
          bAct[idx] = 1;
        } else {
          bAng[idx] = FALLBACK_BRANCH_ANGLE[branch];
          bAct[idx] = 0;
        }
      });
    }

    if (this.guideMat) {
      const c = this.light ? rgb.inkDim : rgb.inkDim;
      (this.guideMat.uniforms.uColor!.value as Vector3).set(c[0] / 255, c[1] / 255, c[2] / 255);
      this.guideMat.uniforms.uFocusDim!.value = focusDim;
    }

    if (this.dustMat) {
      this.dustMat.uniforms.uLight!.value = lightFlag;
      this.dustMat.uniforms.uTime!.value = tSec;
      this.dustMat.uniforms.uMotion!.value = motionFlag;
    }

    if (this.ribbonMat) {
      const u = this.ribbonMat.uniforms;
      u.uTime!.value = tSec;
      u.uMotion!.value = motionFlag;
      u.uLight!.value = lightFlag;
      (u.uFreshRgb!.value as Vector3).set(rgb.fresh[0] / 255, rgb.fresh[1] / 255, rgb.fresh[2] / 255);
    }

    if (this.pointMat) {
      const u = this.pointMat.uniforms;
      u.uFocus!.value = this.fitDist * this.zoom;
      u.uRange!.value = this.focusRange();
      u.uScale!.value = SPRITE_K * this.focalPx() * this.pixelRatio;
      u.uLight!.value = lightFlag;
      u.uTime!.value = tSec;
      u.uMotion!.value = motionFlag;
      (u.uFreshRgb!.value as Vector3).set(rgb.fresh[0] / 255, rgb.fresh[1] / 255, rgb.fresh[2] / 255);
      (u.uStaleRgb!.value as Vector3).set(rgb.stale[0] / 255, rgb.stale[1] / 255, rgb.stale[2] / 255);
      (u.uInkRgb!.value as Vector3).set(rgb.ink[0] / 255, rgb.ink[1] / 255, rgb.ink[2] / 255);
      (u.uStageRgb!.value as Vector3).set(rgb.stageCore[0] / 255, rgb.stageCore[1] / 255, rgb.stageCore[2] / 255);
    }
  }

  private writePulse(now: number): void {
    const size = this.pointGeo.getAttribute("aSize") as BufferAttribute | undefined;
    if (!size || this.coreIndex < 0) return;
    const pulse = this.pulse ? 0.5 + 0.5 * Math.sin(now / 900) : 0;
    size.setX(this.coreIndex, this.isVisible("core") ? this.size[this.coreIndex]! * (1 + pulse * 0.08) : 0);
    size.needsUpdate = true;
  }

  private nodeRgb(i: number): Rgb {
    return this.rgb![paletteKeyOf(this.nodes[i]!)];
  }

  private writeBuffers(): void {
    const rgb = this.rgb;
    if (!rgb) return;
    const crowd = clamp((this.nodes.length - CROWD_FROM) / (CROWD_TO - CROWD_FROM), 0, 1);
    const alphaScale = lerp(1, 0.88, crowd);
    const focus = this.focus;
    const linkRgb = rgb.link;
    const objectiveRgb = rgb.objective;

    const color = this.pointGeo.getAttribute("aColor") as BufferAttribute;
    const size = this.pointGeo.getAttribute("aSize") as BufferAttribute;
    const alpha = this.pointGeo.getAttribute("aAlpha") as BufferAttribute;
    const fresh = this.pointGeo.getAttribute("aFresh") as BufferAttribute;
    const stale = this.pointGeo.getAttribute("aStale") as BufferAttribute;
    const active = this.pointGeo.getAttribute("aActive") as BufferAttribute;
    const colors: Rgb[] = [];
    const shown: boolean[] = [];

    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i]!;
      const visible = this.isVisible(node.id);
      shown.push(visible);
      const c = this.nodeRgb(i);
      colors.push(c);
      color.setXYZ(i, c[0] / 255, c[1] / 255, c[2] / 255);
      this.size[i] = this.baseSize(i);
      size.setX(i, visible ? this.size[i]! : 0);
      const isDim = focus !== null && focus[i] !== 1;
      let a = 0.96 * alphaScale;
      if (node.kind === "topic") a *= 0.78;
      if (node.kind === "objective" && focus === null) a *= 0.82;
      if (node.stale) a *= 0.62;
      // 다른 점에 호버 중이어도 선택 링이 둘린 점 자체는 어둠 속에 묻히지 않게 유지한다.
      if (isDim) a *= node.id === this.selection ? 0.55 : 0.14;
      alpha.setX(i, visible ? a : 0);
      fresh.setX(i, visible && node.fresh && !isDim ? 1 : 0);
      stale.setX(i, visible && node.stale && !isDim ? 1 : 0);
      const act = !visible ? 0 : node.id === this.selection ? 2 : node.id === this.hover ? 1 : 0;
      active.setX(i, act);
    }
    color.needsUpdate = true;
    size.needsUpdate = true;
    alpha.needsUpdate = true;
    fresh.needsUpdate = true;
    stale.needsUpdate = true;
    active.needsUpdate = true;

    const rWidth = this.ribbonGeo.getAttribute("aWidth") as BufferAttribute;
    const rAlpha = this.ribbonGeo.getAttribute("aAlpha") as BufferAttribute;
    const rPulse = this.ribbonGeo.getAttribute("aPulse") as BufferAttribute;
    const rColA = this.ribbonGeo.getAttribute("aColorA") as BufferAttribute;
    const rColB = this.ribbonGeo.getAttribute("aColorB") as BufferAttribute;
    const focusIndex = this.focusId !== null ? this.index.get(this.focusId) : undefined;
    const vertsPerEdge = (EDGE_SEGMENTS + 1) * 2;
    const lightMul = this.light ? 0.88 : 1.0;

    for (let e = 0; e < this.edgeList.length; e += 1) {
      const edge = this.edgeList[e]!;
      const live = shown[edge.a]! && shown[edge.b]!;
      const touches = focusIndex !== undefined && (edge.a === focusIndex || edge.b === focusIndex);
      let ea = live ? edge.baseAlpha * lightMul : 0;
      if (live && focusIndex !== undefined) {
        ea = touches ? Math.min(0.95, edge.baseAlpha * 1.9 + 0.30) : edge.baseAlpha * 0.11;
      }
      const ew = !live ? 0 : touches ? Math.max(edge.baseWidth * 1.45, 2.2) : edge.baseWidth;
      const ep = !live ? 0
        : touches ? 2
          : (edge.isTrunk || (edge.kind === "link" && e % 2 === 0)) && focusIndex === undefined ? 1
            : 0;

      let colA: Rgb = colors[edge.a]!;
      let colB: Rgb = colors[edge.b]!;
      if (edge.kind === "link") { colA = linkRgb; colB = linkRgb; }
      else if (edge.kind === "objective" || edge.kind === "source") {
        const c = touches ? linkRgb : objectiveRgb;
        colA = c; colB = c;
      } else if (!edge.isTrunk) {
        colA = colB;
      }

      const vBase = e * vertsPerEdge;
      for (let k = 0; k < vertsPerEdge; k += 1) {
        const v = vBase + k;
        rWidth.setX(v, ew);
        rAlpha.setX(v, ea);
        rPulse.setX(v, ep);
        rColA.setXYZ(v, colA[0] / 255, colA[1] / 255, colA[2] / 255);
        rColB.setXYZ(v, colB[0] / 255, colB[1] / 255, colB[2] / 255);
      }
    }
    rWidth.needsUpdate = true;
    rAlpha.needsUpdate = true;
    rPulse.needsUpdate = true;
    rColA.needsUpdate = true;
    rColB.needsUpdate = true;
  }
}

export function createMapRenderer(): MapWebglRenderer {
  return new MapWebglRendererImpl();
}
