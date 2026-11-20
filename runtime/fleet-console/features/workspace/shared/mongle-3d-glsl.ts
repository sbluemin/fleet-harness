import type { MongleActivity, MongleRole, MongleShape, MongleState, QuakerMorph } from "./avatars.js";
import type { IdentityTone } from "./identity-tones.js";

/**
 * 몽글·진급 퀘이커 3D 아바타의 공통 팔레트·코드 매핑 및 순수 GLSL SDF 조형 원천(SSOT).
 *
 * 2D 콘솔 아바타 캔버스(`mongle-3d-renderer.ts`)와 3D 월드(`features/the-world`)가 같은 몸 모양·제독복·별 배지·안테나·소품
 * 공식을 공유해 두 화면 사이에서 캐릭터 모습이 갈라지지 않게 한다.
 */

export type MongleRgb = readonly [number, number, number];

/** 일반 몽글(1–15) — Plush Vivid 팔레트. */
export const PLUSH_VIVID_TONES: Readonly<Record<IdentityTone, MongleRgb>> = {
  crimson:  [0.96, 0.24, 0.30],
  amber:    [0.99, 0.67, 0.14],
  moss:     [0.10, 0.84, 0.36],
  teal:     [0.10, 0.80, 0.76],
  cerulean: [0.14, 0.68, 0.99],
  indigo:   [0.40, 0.42, 0.99],
  plum:     [0.94, 0.30, 0.82],
  rose:     [0.99, 0.36, 0.64],
};

/** 진급 퀘이커(토리·보리·도리) — Fleet Pastel 팔레트. */
export const QUAKER_PASTEL_TONES: Readonly<Record<QuakerMorph, MongleRgb>> = {
  tori: [0.67, 0.84, 0.61],
  bori: [0.89, 0.60, 0.57],
  dori: [0.58, 0.78, 0.93],
};

export const MONGLE_SHAPE_CODE: Readonly<Record<MongleShape, number>> = {
  bang: 0, gureum: 1, tteok: 2, kong: 3, mul: 4,
  kkot: 5, dol: 6, sat: 7, egg: 8, mandu: 9,
};

export const QUAKER_MORPH_CODE: Readonly<Record<QuakerMorph, number>> = {
  tori: 1, bori: 2, dori: 3,
};

export const MONGLE_STATE_CODE: Readonly<Record<MongleState, number>> = {
  idle: 0, running: 1, awaiting: 2, decision: 3, review: 4,
  unseen: 5, done: 6, ended: 7, error: 8, fresh: 9,
};

export const MONGLE_ACTIVITY_CODE: Readonly<Record<MongleActivity, number>> = {
  think: 1, read: 2, edit: 3, run: 4, fetch: 5,
  delegate: 6, text: 7, compact: 8, background: 9,
};

export const MONGLE_ROLE_CODE: Readonly<Record<MongleRole, number>> = {
  commodore: 0, commander: 1, member: 2,
};

export const MONGLE_SDF_MATH_GLSL = /* glsl */ `
mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i + vec3(0.0,0.0,0.0)), hash13(i + vec3(1.0,0.0,0.0)), f.x),
        mix(hash13(i + vec3(0.0,1.0,0.0)), hash13(i + vec3(1.0,1.0,0.0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0.0,0.0,1.0)), hash13(i + vec3(1.0,0.0,1.0)), f.x),
        mix(hash13(i + vec3(0.0,1.0,1.0)), hash13(i + vec3(1.0,1.0,1.0)), f.x), f.y),
    f.z
  );
}

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float sdSphere(vec3 p, float r) { return length(p) - r; }

float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a;
  float l2 = dot(ba, ba);
  float rr = r1 - r2;
  float a2 = l2 - rr * rr;
  float il2 = 1.0 / max(l2, 1e-5);
  vec3 pa = p - a;
  float y = dot(pa, ba);
  float z = y - l2;
  vec3 d = pa * l2 - ba * y;
  float x2 = dot(d, d);
  float y2 = y * y * l2;
  float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(max(x2 * a2 * il2, 0.0)) + y * rr) * il2 - r1;
}

float sdSeg2(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  return length(pa - ba * h);
}

float sdRoundedBox2(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float sdStar5_2D(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
`;

export const MONGLE_BODY_GLSL = /* glsl */ `
float sdMongleBody(vec3 p, int shp) {
  if (shp == 0) {
    vec3 q = p;
    q.y += 0.035 * (1.0 - smoothstep(-0.55, 0.35, q.y));
    return sdEllipsoid(q, vec3(0.68, 0.62, 0.54));
  } else if (shp == 1) {
    float d = sdSphere(p - vec3(0.0, 0.22, 0.0), 0.42);
    d = smin(d, sdSphere(p - vec3(-0.36, -0.08, 0.02), 0.39), 0.22);
    d = smin(d, sdSphere(p - vec3( 0.36, -0.08, 0.02), 0.39), 0.22);
    d = smin(d, sdSphere(p - vec3(0.0, -0.18, 0.04), 0.40), 0.22);
    d = smin(d, sdSphere(p - vec3(0.0,  0.00,-0.12), 0.38), 0.24);
    return d;
  } else if (shp == 2) {
    vec3 q = p;
    float bulge = 0.045 * cos(clamp(q.x * 2.2, -1.5, 1.5)) * cos(clamp(q.y * 2.2, -1.5, 1.5));
    return sdRoundBox(q, vec3(0.39, 0.36, 0.21), 0.27) - bulge;
  } else if (shp == 3) {
    vec3 q = p;
    q.xy = rot2(-0.18) * q.xy;
    q.y -= 0.14 * q.x * q.x;
    q.z *= 1.18;
    return sdCapsule(q, vec3(-0.26, 0.0, 0.0), vec3(0.26, 0.0, 0.0), 0.43) * 0.85;
  } else if (shp == 4) {
    float d1 = sdEllipsoid(p - vec3(0.0, -0.16, 0.0), vec3(0.62, 0.48, 0.50));
    float d2 = sdRoundCone(p, vec3(0.0, -0.12, 0.0), vec3(0.0, 0.62, 0.0), 0.44, 0.10);
    return smin(d1, d2, 0.28);
  } else if (shp == 5) {
    float d = sdEllipsoid(p, vec3(0.46, 0.46, 0.37));
    for (int i = 0; i < 5; i++) {
      float a = 1.5707963 + float(i) * 1.2566371;
      vec3 c = vec3(cos(a) * 0.37, sin(a) * 0.37, 0.0);
      float pet = sdEllipsoid(p - c, vec3(0.33, 0.33, 0.31));
      d = smin(d, pet, 0.18);
    }
    return d;
  } else if (shp == 6) {
    vec3 q = p;
    q.xy = rot2(-0.22) * q.xy;
    q.y += 0.04 * sin(q.x * 2.5);
    return sdEllipsoid(q, vec3(0.73, 0.54, 0.47));
  } else if (shp == 7) {
    float d = sdEllipsoid(p, vec3(0.50, 0.50, 0.38));
    for (int i = 0; i < 6; i++) {
      float a = 1.5707963 + float(i) * 1.0471975;
      vec3 c = vec3(cos(a) * 0.44, sin(a) * 0.44, 0.0);
      float lobe = sdEllipsoid(p - c, vec3(0.26, 0.26, 0.28));
      d = smin(d, lobe, 0.15);
    }
    return d;
  } else if (shp == 8) {
    float tap = mix(1.12, 0.78, smoothstep(-0.68, 0.68, p.y));
    vec3 q = vec3(p.x / tap, p.y, p.z / tap);
    return sdEllipsoid(q, vec3(0.56, 0.69, 0.50)) * 0.78;
  } else if (shp == 9) {
    float base = sdRoundBox(p - vec3(0.0, -0.23, 0.0), vec3(0.45, 0.15, 0.28), 0.22);
    float dome = sdEllipsoid(p - vec3(0.0,  0.03, 0.0), vec3(0.61, 0.54, 0.47));
    float pleat = sdEllipsoid(p - vec3(0.0, 0.54, 0.0), vec3(0.22, 0.10, 0.11));
    return smin(smin(base, dome, 0.24), pleat, 0.12);
  } else {
    vec3 pq = p - vec3(0.0, 0.08, 0.0);
    float head = sdSphere(pq - vec3(0.0, -0.05, 0.0), 0.50);
    float chL  = sdSphere(pq - vec3(-0.22, -0.21, 0.13), 0.27);
    float chR  = sdSphere(pq - vec3( 0.22, -0.21, 0.13), 0.27);
    float bust = sdEllipsoid(pq - vec3(0.0, -0.54, -0.03), vec3(0.42, 0.32, 0.36));
    float d = smin(head, smin(chL, chR, 0.16), 0.18);
    d = smin(d, bust, 0.16);
    return d;
  }
}

float shapeCrownY(int shp) {
  if (shp == 0) return 0.62;
  if (shp == 1) return 0.64;
  if (shp == 2) return 0.63;
  if (shp == 3) return 0.50;
  if (shp == 4) return 0.68;
  if (shp == 5) return 0.69;
  if (shp == 6) return 0.55;
  if (shp == 7) return 0.69;
  if (shp == 8) return 0.69;
  return 0.61;
}

vec2 opU(vec2 a, vec2 b) { return a.x < b.x ? a : b; }
`;
