import {
  BackSide,
  BoxGeometry,
  CircleGeometry,
  DoubleSide,
  GLSL3,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";

import {
  MONGLE_ACTIVITY_CODE,
  MONGLE_BODY_GLSL,
  MONGLE_ROLE_CODE,
  MONGLE_SDF_MATH_GLSL,
  MONGLE_SHAPE_CODE,
  MONGLE_STATE_CODE,
  PLUSH_VIVID_TONES,
  QUAKER_MORPH_CODE,
  QUAKER_PASTEL_TONES,
} from "../../../workspace/shared/mongle-3d-glsl.js";
import type { MongleActivity, MongleRole, MongleShape, MongleState, QuakerMorph } from "../../../workspace/shared/avatars.js";
import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";

/**
 * `mongle-3d-glsl.ts` (현행 2D 사이드바 아바타와 동일 SSOT) 기반 360° 3D 월드 볼류메트릭 캐릭터 메쉬.
 *
 * - 제독모(Admiral Cap) 상단 솜결 번짐 방지 마스킹 및 낮 시간대 알베도 클램핑 적용
 * - 발밑 3D 타깃 링(선택 시 황동빛 링 · `[E]` 근접 시 하늘빛 링) 및 다이아몬드 승인 비콘 포함
 */

const ACTOR_VERTEX = /* glsl */ `
uniform vec3 uCharCenter;
uniform float uCharScale;
out vec3 vWorldPos;

void main() {
  vec3 wp = uCharCenter + position * (1.46 * uCharScale);
  vWorldPos = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const ACTOR_FRAGMENT = /* glsl */ `
in vec3 vWorldPos;
out vec4 fragColor;

uniform mat4 uViewProj;
uniform vec3 uCharCenter;
uniform float uCharScale;
uniform float uCharYaw;
uniform float uTime;
uniform float uPhase;
uniform float uFuzz;
uniform int uShape;
uniform int uQuaker;
uniform int uState;
uniform int uActivity;
uniform int uRole;
uniform vec3 uBaseCol;
uniform vec3 uWorldLightDir;
uniform vec3 uWorldTint;

${MONGLE_SDF_MATH_GLSL}
${MONGLE_BODY_GLSL}

struct AnimRig {
  vec3 offset;
  vec3 scale;
  float roll;
  float yawAdd;
  float pitchAdd;
  vec2 eyeShift;
  float eyeBlink;
  float wingFlap;
};

AnimRig computeAnim() {
  AnimRig r;
  r.offset = vec3(0.0);
  r.scale = vec3(1.0);
  r.roll = 0.0;
  r.yawAdd = 0.0;
  r.pitchAdd = 0.0;
  r.eyeShift = vec2(0.0);
  r.eyeBlink = 1.0;
  r.wingFlap = 0.0;

  float t = uTime + uPhase;
  if (uQuaker > 0) {
    float wAmp = (uState == 1 || uState == 2) ? 0.32 : 0.15;
    float wSpd = (uState == 1 || uState == 2) ? 7.2 : 3.4;
    r.wingFlap = sin(t * wSpd) * wAmp;
  }

  float bt = fract(t / 4.4);
  if (bt > 0.92 && bt < 0.98) {
    r.eyeBlink = mix(1.0, 0.12, sin((bt - 0.92) / 0.06 * 3.14159));
  }

  if (uState == 0) {
    float breath = sin(t * 2.2);
    r.scale = vec3(1.0 + breath * 0.025, 1.0 - breath * 0.026, 1.0 + breath * 0.018);
    r.roll = sin(t * 1.2) * 0.04;
  } else if (uState == 1) {
    r.roll = sin(t * 1.8) * 0.06;
    if (uActivity == 1) {
      float w = sin(t * 2.2);
      r.roll = -0.12 + w * 0.05;
      r.eyeShift = vec2(sin(t * 1.5) * 0.04, 0.04);
    } else if (uActivity == 2) {
      r.pitchAdd = 0.07;
      r.eyeShift = vec2(sin(t * 2.6) * 0.05, -0.04);
    } else if (uActivity == 3) {
      float w = sin(t * 7.8);
      r.scale = vec3(1.0 + w * 0.06, 1.0 - w * 0.07, 1.0 + w * 0.03);
      r.eyeShift = vec2(-0.02, -0.035);
    } else if (uActivity == 4) {
      float p = fract(t * 0.9);
      float sq = sin(p * 6.28318);
      r.scale = vec3(1.0 - sq * 0.08, 1.0 + sq * 0.09, 1.0 - sq * 0.05);
    } else if (uActivity == 5) {
      float sc = sin(t * 2.6);
      r.yawAdd = sc * 0.18;
      r.eyeShift = vec2(sc * 0.05, 0.025);
    } else if (uActivity == 6) {
      float w = sin(t * 4.2);
      r.scale = vec3(1.0 - w * 0.04, 1.0 + w * 0.05, 1.0);
    }
  } else if (uState == 2 || uState == 3) {
    float sw = sin(t * 2.4);
    r.roll = sw * 0.16;
    r.eyeShift = vec2(0.0, 0.035);
  }
  return r;
}

vec3 toLocal(vec3 p, AnimRig rig) {
  vec3 q = p - rig.offset;
  q.xz = rot2(-rig.yawAdd) * q.xz;
  q.yz = rot2(-rig.pitchAdd) * q.yz;
  q.xy = rot2(-rig.roll) * q.xy;
  q /= rig.scale;
  return q;
}

float sdPlushOnly(vec3 p, AnimRig rig) {
  vec3 q = toLocal(p, rig);
  float sMin = min(rig.scale.x, min(rig.scale.y, rig.scale.z));
  float d = sdMongleBody(q, uShape) * sMin;
  if (uQuaker > 0) {
    vec3 pq = q - vec3(0.0, 0.08, 0.0);
    vec3 wl = pq - vec3(-0.44, -0.43, -0.03);
    wl.xy = rot2(0.28 + rig.wingFlap) * wl.xy;
    float dwL = sdEllipsoid(wl - vec3(-0.14, -0.06, 0.0), vec3(0.20, 0.125, 0.13)) * sMin;
    vec3 wr = pq - vec3(0.44, -0.43, -0.03);
    wr.xy = rot2(-0.28 - rig.wingFlap) * wr.xy;
    float dwR = sdEllipsoid(wr - vec3(0.14, -0.06, 0.0), vec3(0.20, 0.125, 0.13)) * sMin;
    d = min(d, min(dwL, dwR));
  }
  return d;
}

vec2 mapScene(vec3 p, AnimRig rig) {
  vec3 q = toLocal(p, rig);
  float sMin = min(rig.scale.x, min(rig.scale.y, rig.scale.z));
  float t = uTime + uPhase;
  vec2 res = vec2(sdMongleBody(q, uShape) * sMin, 0.0);

  if (uQuaker > 0) {
    vec3 pq = q - vec3(0.0, 0.08, 0.0);
    vec3 wl = pq - vec3(-0.44, -0.43, -0.03);
    wl.xy = rot2(0.28 + rig.wingFlap) * wl.xy;
    float dwL = sdEllipsoid(wl - vec3(-0.14, -0.06, 0.0), vec3(0.20, 0.125, 0.13)) * sMin;
    vec3 wr = pq - vec3(0.44, -0.43, -0.03);
    wr.xy = rot2(-0.28 - rig.wingFlap) * wr.xy;
    float dwR = sdEllipsoid(wr - vec3(0.14, -0.06, 0.0), vec3(0.20, 0.125, 0.13)) * sMin;
    res = opU(res, vec2(min(dwL, dwR), 7.0));

    vec3 el = pq - vec3(-0.38, -0.39, 0.06); el.xy = rot2(0.32) * el.xy;
    vec3 er = pq - vec3( 0.38, -0.39, 0.06); er.xy = rot2(-0.32) * er.xy;
    res = opU(res, vec2(min(sdRoundBox(el, vec3(0.105,0.036,0.072), 0.024), sdRoundBox(er, vec3(0.105,0.036,0.072), 0.024)) * sMin, 4.0));

    vec3 bp = pq - vec3(0.0, -0.16, 0.47);
    res = opU(res, vec2(sdRoundCone(bp, vec3(0.0, 0.048, -0.02), vec3(0.0, -0.082, 0.105), 0.090, 0.030) * sMin, 6.0));

    vec3 cp = pq - vec3(0.0, 0.41, 0.0); cp.yz = rot2(-0.14) * cp.yz;
    float crown = smin(sdEllipsoid(cp - vec3(0.0, 0.17, -0.02), vec3(0.55, 0.165, 0.49)),
                       sdEllipsoid(cp - vec3(0.0, 0.22,  0.22), vec3(0.26, 0.12,  0.22)), 0.10);
    res = opU(res, vec2(crown * sMin, 3.0));
    res = opU(res, vec2(sdEllipsoid(cp - vec3(0.0, -0.015, 0.0), vec3(0.45, 0.092, 0.42)) * sMin, 5.0));

    vec3 vp = cp - vec3(0.0, -0.095, 0.30); vp.yz = rot2(0.24) * vp.yz;
    res = opU(res, vec2(sdEllipsoid(vp, vec3(0.30, 0.040, 0.185)) * sMin, 2.0));

    vec3 ap = cp - vec3(0.0, 0.055, 0.435);
    float anc = min(sdCapsule(ap, vec3(0.0,-0.055,0.0), vec3(0.0,0.055,0.0), 0.017),
                    sdCapsule(ap, vec3(-0.044,0.02,0.0), vec3(0.044,0.02,0.0), 0.014));
    float cord = sdCapsule(cp - vec3(0.0, -0.058, 0.41), vec3(-0.24, 0.018, -0.06), vec3(0.24, 0.018, -0.06), 0.017);
    res = opU(res, vec2(min(anc, cord) * sMin, 4.0));
  } else {
    if (uRole == 0) {
      vec3 sp = q - vec3(-0.56, 0.54, 0.22);
      sp.yz = rot2(0.08) * sp.yz; sp.xz = rot2(-0.18) * sp.xz;
      res = opU(res, vec2(sdEllipsoid(sp, vec3(0.185, 0.185, 0.068)) * sMin, 4.0));
    } else if (uRole == 1) {
      float topY = shapeCrownY(uShape);
      vec3 tip = vec3(sin(t * 3.0) * 0.04, topY + 0.27, 0.0);
      res = opU(res, vec2(sdCapsule(q, vec3(0.0, topY - 0.06, 0.0), tip, 0.032) * sMin, 5.0));
      res = opU(res, vec2(sdSphere(q - tip, 0.115) * sMin, 6.0));
    }

    if (uState == 1) {
      if (uActivity == 1) {
        float pulse = sin(t * 3.8) * 0.025;
        float dB = min(sdSphere(q - vec3(0.46, 0.42 + pulse, 0.24), 0.048),
                   min(sdSphere(q - vec3(0.58, 0.56 + pulse * 1.4, 0.22), 0.072),
                       sdSphere(q - vec3(0.74, 0.72 + pulse * 1.8, 0.20), 0.105)));
        res = opU(res, vec2(dB * sMin, 3.0));
        res = opU(res, vec2(sdSphere(q - vec3(-0.22, -0.34 + abs(sin(t*4.5))*0.04, 0.48), 0.11) * sMin, 7.0));
      } else if (uActivity == 2) {
        vec3 bp = q - vec3(0.0, -0.38, 0.56); bp.yz = rot2(0.32) * bp.yz;
        vec3 pL = bp - vec3(-0.18, 0.0, 0.02); pL.xz = rot2(-0.28) * pL.xz;
        vec3 pR = bp - vec3( 0.18, 0.0, 0.02); pR.xz = rot2( 0.28) * pR.xz;
        res = opU(res, vec2(min(sdRoundBox(pL, vec3(0.17,0.135,0.02), 0.015), sdRoundBox(pR, vec3(0.17,0.135,0.02), 0.015)) * sMin, 3.0));
        res = opU(res, vec2(min(sdSphere(q - vec3(-0.35,-0.42,0.56), 0.10), sdSphere(q - vec3(0.35,-0.42+max(0.0,sin(t*2.8))*0.08,0.56), 0.10)) * sMin, 7.0));
      } else if (uActivity == 3) {
        vec3 np = q - vec3(-0.30, -0.42, 0.54); np.yz = rot2(0.22) * np.yz;
        res = opU(res, vec2(sdRoundBox(np, vec3(0.19, 0.135, 0.022), 0.016) * sMin, 3.0));
        vec3 sc = vec3(sin(t * 14.0) * 0.05, cos(t * 11.0) * 0.035, 0.0);
        vec3 pp = q - (vec3(0.18, -0.30, 0.58) + sc); pp.xy = rot2(-0.72) * pp.xy;
        res = opU(res, vec2(sdCapsule(pp, vec3(-0.23,0.0,0.0), vec3(0.23,0.0,0.0), 0.046) * sMin, 6.0));
        res = opU(res, vec2(sdSphere(q - (vec3(0.26,-0.25,0.56) + sc*0.8), 0.10) * sMin, 7.0));
      } else if (uActivity == 4) {
        float lift = sin(t * 5.2) * 0.12;
        res = opU(res, vec2(min(sdSphere(q - vec3(-0.74,0.08+lift,0.18), 0.12), sdSphere(q - vec3(0.74,0.08+lift,0.18), 0.12)) * sMin, 7.0));
      } else if (uActivity == 5) {
        vec3 tp = q - vec3(0.46, 0.04, 0.44); tp.xy = rot2(0.32 + sin(t * 2.6) * 0.25) * tp.xy;
        res = opU(res, vec2(sdRoundCone(tp, vec3(-0.18,0.0,0.0), vec3(0.28,0.0,0.0), 0.055, 0.095) * sMin, 5.0));
        res = opU(res, vec2(sdEllipsoid(tp - vec3(0.29,0.0,0.0), vec3(0.03,0.09,0.09)) * sMin, 3.0));
        res = opU(res, vec2(sdSphere(q - vec3(0.44,-0.10,0.45), 0.105) * sMin, 7.0));
      } else if (uActivity == 6) {
        vec3 wp = q - vec3(0.66, 0.26, 0.22); wp.xy = rot2(sin(t * 6.5) * 0.35) * wp.xy;
        res = opU(res, vec2(sdSphere(wp - vec3(0.05,0.08,0.0), 0.125) * sMin, 7.0));
      }
    }
  }
  return res;
}

vec3 calcNormal(vec3 p, AnimRig rig) {
  vec2 e = vec2(0.003, -0.003);
  return normalize(
    e.xyy * mapScene(p + e.xyy, rig).x +
    e.yyx * mapScene(p + e.yyx, rig).x +
    e.yxy * mapScene(p + e.yxy, rig).x +
    e.xxx * mapScene(p + e.xxx, rig).x
  );
}

vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0005)), vec3(2.2)); }

vec3 plushColorAt(vec3 q, bool isWing) {
  vec3 col = uBaseCol;
  if (uQuaker > 0) {
    if (uQuaker == 1) col = isWing ? mix(uBaseCol, vec3(0.32, 0.52, 0.34), 0.28) : uBaseCol;
    else if (uQuaker == 2) col = isWing ? vec3(0.92, 0.89, 0.88) : vec3(0.95, 0.93, 0.92);
    else col = isWing ? mix(uBaseCol, vec3(0.32, 0.52, 0.72), 0.26) : uBaseCol;

    vec3 pq = q - vec3(0.0, 0.08, 0.0);
    float bibFace = 1.0 - smoothstep(0.26, 0.40, length((pq.xy - vec2(0.0, -0.23)) / vec2(0.90, 0.60)));
    float bibChest = 1.0 - smoothstep(0.25, 0.37, length((pq.xy - vec2(0.0, -0.55)) / vec2(0.84, 0.78)));
    float bibMask = max(bibFace, bibChest) * smoothstep(0.05, 0.26, pq.z);
    vec3 bibCol = (uQuaker == 2) ? vec3(0.99, 0.98, 0.97) : mix(col, vec3(0.96, 0.96, 0.94), 0.78);
    if (!isWing) col = mix(col, bibCol, bibMask);
  } else if (isWing) {
    col = mix(col, vec3(0.14, 0.14, 0.20), 0.16);
  }
  return col;
}

vec3 worldToLocalPos(vec3 wp) {
  vec3 d = (wp - uCharCenter) / uCharScale;
  float c = cos(uCharYaw), s = sin(uCharYaw);
  return vec3(d.x * c - d.z * s, d.y, d.x * s + d.z * c);
}
vec3 localToWorldPos(vec3 lp) {
  float c = cos(uCharYaw), s = sin(uCharYaw);
  vec3 r = vec3(lp.x * c + lp.z * s, lp.y, -lp.x * s + lp.z * c);
  return uCharCenter + r * uCharScale;
}
vec3 worldToLocalDir(vec3 wd) {
  float c = cos(uCharYaw), s = sin(uCharYaw);
  return normalize(vec3(wd.x * c - wd.z * s, wd.y, wd.x * s + wd.z * c));
}

void main() {
  vec3 ro = worldToLocalPos(cameraPosition);
  vec3 pFrag = worldToLocalPos(vWorldPos);
  vec3 rd = normalize(pFrag - ro);

  float b = dot(ro, rd);
  float c = dot(ro, ro) - 1.44 * 1.44;
  float disc = b * b - c;
  if (disc < 0.0) discard;

  float tStart = max(0.0, -b - sqrt(disc));
  float tEnd = -b + sqrt(disc);
  AnimRig rig = computeAnim();

  float t = tStart;
  float hitMat = -1.0;
  float tHit = tEnd;
  float minPlushD = 9.9;
  float minPlushT = tStart;

  for (int i = 0; i < 48; i++) {
    vec3 p = ro + rd * t;
    vec2 h = mapScene(p, rig);
    if ((h.y == 0.0 || h.y == 7.0) && h.x < minPlushD) {
      minPlushD = h.x;
      minPlushT = t;
    }
    if (h.x < 0.0028) {
      hitMat = h.y;
      tHit = t;
      break;
    }
    t += max(h.x * 0.88, 0.008);
    if (t > tEnd) break;
  }

  vec3 L1 = worldToLocalDir(uWorldLightDir);
  vec3 V = -rd;
  vec3 coreCol = vec3(0.0);
  float coreAlpha = 0.0;
  float grazeMask = 1.0;

  if (hitMat >= 0.0) {
    vec3 p = ro + rd * tHit;
    vec3 q = toLocal(p, rig);
    vec3 N = calcNormal(p, rig);
    int mId = int(hitMat + 0.5);

    if (mId == 0 || mId == 7) {
      bool isWing = (mId == 7);
      vec3 pCol = plushColorAt(q, isWing);
      grazeMask = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.5) * 0.78;

      vec3 nLoc = N;
      nLoc.xz = rot2(-rig.yawAdd) * nLoc.xz;
      nLoc.yz = rot2(-rig.pitchAdd) * nLoc.yz;
      nLoc.xy = rot2(-rig.roll) * nLoc.xy;
      nLoc = normalize(nLoc);

      float eyeMask = 0.0;
      float eyeGlint = 0.0;
      if (!isWing && q.z > 0.08 && nLoc.z > 0.14) {
        float frontFade = smoothstep(0.14, 0.34, nLoc.z);
        if (uQuaker > 0) {
          vec3 pq = q - vec3(0.0, 0.08, 0.0);
          vec2 ep = pq.xy - vec2(0.0, -0.015) - rig.eyeShift * 0.55;
          vec2 eLb = vec2(ep.x + 0.185, ep.y / max(rig.eyeBlink, 0.10));
          vec2 eRb = vec2(ep.x - 0.185, ep.y / max(rig.eyeBlink, 0.10));
          float dRing = min(length(eLb), length(eRb)) - 0.112;
          float dPupil = min(length(eLb), length(eRb)) - 0.090;
          pCol = mix(pCol, vec3(0.97, 0.97, 0.95), (1.0 - smoothstep(-0.008, 0.008, dRing)) * frontFade);
          eyeMask = (1.0 - smoothstep(-0.008, 0.008, dPupil)) * frontFade;
          vec2 nearE = (length(eLb) < length(eRb)) ? eLb : eRb;
          eyeGlint = (1.0 - smoothstep(0.022, 0.034, length(nearE - vec2(-0.028, 0.028)))) * eyeMask;
          if (uQuaker != 2) {
            float bM = min(length((pq.xy - vec2(-0.29,-0.18))/vec2(0.095,0.058)), length((pq.xy - vec2(0.29,-0.18))/vec2(0.095,0.058)));
            pCol = mix(pCol, vec3(0.95, 0.56, 0.64), (1.0 - smoothstep(0.30, 1.0, bM)) * 0.48 * frontFade);
          }
        } else {
          float eyeY = (uShape == 4) ? -0.10 : (uShape == 9 ? -0.04 : 0.01);
          vec2 ep = q.xy - vec2(0.0, eyeY) - rig.eyeShift;
          float hE = max(0.018, 0.122 * rig.eyeBlink);
          float dEye = min(sdRoundedBox2(ep - vec2(-0.182, 0.0), vec2(0.078, hE), 0.074),
                           sdRoundedBox2(ep - vec2( 0.182, 0.0), vec2(0.078, hE), 0.074));
          eyeMask = (1.0 - smoothstep(-0.008, 0.009, dEye)) * frontFade;
        }
      }
      grazeMask *= (1.0 - eyeMask);

      vec3 baseLin = toLinear(pCol);
      vec3 fp = q * 38.0;
      float n0 = noise3(fp);
      vec3 fGrad = vec3(noise3(fp + vec3(0.18,0,0)) - n0, noise3(fp + vec3(0,0.18,0)) - n0, noise3(fp + vec3(0,0,0.18)) - n0);
      vec3 Nf = normalize(N + fGrad * 0.62);
      float diff = clamp((dot(Nf, L1) + 0.38) / 1.38, 0.0, 1.0);
      vec3 deepCol = pow(max(baseLin, vec3(0.002)), vec3(1.38)) * 0.16;
      vec3 hiCol = baseLin * 1.12 + vec3(0.024);
      coreCol = mix(deepCol, hiCol, pow(diff, 1.05));
      float velvet = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.5);
      coreCol += mix(baseLin, vec3(0.95), 0.25) * velvet * 0.34;
      coreCol *= (1.0 + (noise3(q * 105.0) - 0.5) * 0.14);
      if (isWing) coreCol *= 0.88;

      if (eyeMask > 0.001) {
        vec3 eyeCol = (uQuaker == 2) ? toLinear(vec3(0.76, 0.30, 0.34)) : vec3(0.012, 0.010, 0.025);
        eyeCol = mix(eyeCol, vec3(1.05), eyeGlint);
        coreCol = mix(coreCol, eyeCol, eyeMask);
      }
    } else {
      grazeMask = 0.0;
      float wrap = clamp((dot(N, L1) + 0.35) / 1.35, 0.0, 1.0);
      vec3 H1 = normalize(L1 + V);
      float spec = pow(max(dot(N, H1), 0.0), 32.0);
      if (mId == 2) coreCol = toLinear(vec3(0.11, 0.13, 0.20)) * (0.35 + 0.90 * wrap) + vec3(0.45) * spec * 0.32;
      else if (mId == 3) {
        // 흰 제독모·노트·종이류: 주간 블룸 번짐이 없도록 선형 알베도 상한을 부드럽게 유지
        coreCol = toLinear(vec3(0.93, 0.92, 0.89)) * (0.36 + 0.62 * wrap);
      }
      else if (mId == 4) {
        vec3 gold = mix(toLinear(vec3(0.38, 0.24, 0.06)), toLinear(vec3(0.94, 0.72, 0.25)), 0.25 + 0.78 * wrap) + vec3(0.95, 0.84, 0.50) * spec * 0.55;
        if (uQuaker == 0 && uRole == 0) {
          vec3 sp = q - vec3(-0.56, 0.54, 0.22); sp.yz = rot2(0.08)*sp.yz; sp.xz = rot2(-0.18)*sp.xz;
          if (sp.z > 0.02) {
            float sm = 1.0 - smoothstep(-0.008, 0.008, sdStar5_2D(vec2(sp.x, -sp.y), 0.132, 0.45));
            gold = mix(gold, vec3(0.015, 0.012, 0.022), sm * 0.95);
          }
        }
        coreCol = gold;
      }
      else if (mId == 5) coreCol = toLinear(vec3(0.16, 0.20, 0.32)) * (0.35 + 0.82 * wrap);
      else if (mId == 6) {
        float antennaBoost = (uQuaker == 0 && uRole == 1) ? 1.25 : 1.0;
        coreCol = toLinear((uQuaker > 0) ? vec3(0.97, 0.67, 0.30) : vec3(1.0, 0.88, 0.34)) * (0.45 + 0.70 * wrap) * antennaBoost;
      }
      else coreCol = toLinear(uBaseCol) * (0.35 + 0.80 * wrap);
    }
    coreAlpha = 1.0;
  }

  float furLen = 0.082 * uFuzz;
  vec3 furAccum = vec3(0.0);
  float furAlpha = 0.0;
  if (furLen > 0.004 && minPlushD < furLen && grazeMask > 0.02) {
    float jitter = hash12(gl_FragCoord.xy);
    float span = (hitMat >= 0.0) ? min(0.088, furLen * 1.22) : 0.22;
    float t0 = (hitMat >= 0.0) ? max(tStart, tHit - span) : max(tStart, minPlushT - span * 0.5);
    float t1 = (hitMat >= 0.0) ? tHit : min(tEnd, minPlushT + span * 0.5);
    float dtS = (t1 - t0) / 6.0;
    for (int s = 0; s < 6; s++) {
      float ts = t0 + (float(s) + jitter) * dtS;
      vec3 ps = ro + rd * ts;
      float dp = sdPlushOnly(ps, rig);
      if (dp > 0.0 && dp < furLen) {
        vec3 qs = toLocal(ps, rig);
        // 퀘이커 제독모 챙 위쪽으로는 몸통 솜결이 새어 나오지 않도록 마스킹
        float capMask = (uQuaker > 0) ? smoothstep(0.44, 0.30, qs.y) : 1.0;
        float strand = smoothstep(0.24, 0.84, noise3(qs * 78.0));
        float tipLen = furLen * (0.25 + 0.75 * strand);
        float h = dp / max(tipLen, 0.001);
        if (h < 1.0 && capMask > 0.01) {
          float a = (1.0 - smoothstep(0.1, 1.0, h)) * 0.52 * grazeMask * capMask * (1.0 - furAlpha);
          vec3 bCol = toLinear(plushColorAt(qs, false)) * 1.05;
          furAccum += bCol * a;
          furAlpha += a;
        }
      }
    }
  }

  float outA = furAlpha + coreAlpha * (1.0 - furAlpha);
  if (outA < 0.02) discard;

  vec3 pre = (furAccum + coreCol * coreAlpha * (1.0 - furAlpha)) * uWorldTint;
  vec3 outLin = pre / outA;

  float depthT = (hitMat >= 0.0) ? tHit : minPlushT;
  vec3 worldHit = localToWorldPos(ro + rd * depthT);
  vec4 clip = uViewProj * vec4(worldHit, 1.0);
  gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;

  fragColor = vec4(outLin, clamp(outA, 0.0, 1.0));
}
`;

export interface MongleActorRigParams {
  readonly baseId: number;
  readonly shape: MongleShape;
  readonly tone: IdentityTone;
  readonly quaker: QuakerMorph | null;
  readonly role: MongleRole;
  readonly scale: number;
}

export interface MongleActorRig {
  readonly group: Group;
  updatePose(options: {
    readonly x: number;
    readonly groundY: number;
    readonly liftY: number;
    readonly z: number;
    readonly yaw: number;
    readonly state: MongleState;
    readonly activity: MongleActivity | null;
    readonly carrying: boolean;
    readonly needsAttention: boolean;
    readonly isSelected?: boolean | undefined;
    readonly isNearPlayer?: boolean | undefined;
    readonly elapsed: number;
    readonly fuzz: number;
    readonly sunDir: Vector3;
    readonly worldTint: Vector3;
    readonly viewProj: import("three").Matrix4;
  }): void;
  dispose(): void;
}

const sharedCubeGeo = new BoxGeometry(2, 2, 2);
const sharedShadowSphereGeo = new SphereGeometry(0.55, 10, 8);
const sharedContactGeo = new CircleGeometry(0.68, 24);
sharedContactGeo.rotateX(-Math.PI * 0.5);
const sharedTargetRingGeo = new RingGeometry(0.66, 0.80, 28);
sharedTargetRingGeo.rotateX(-Math.PI * 0.5);
const sharedCrateGeo = new BoxGeometry(0.38, 0.38, 0.38);
const sharedBeaconGemGeo = new OctahedronGeometry(0.18, 0);

const CONTACT_AO_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CONTACT_AO_FRAGMENT = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
void main() {
  float r = length(vUv * 2.0 - 1.0);
  float a = pow(clamp(1.0 - r, 0.0, 1.0), 1.85) * 0.34;
  if (a < 0.005) discard;
  fragColor = vec4(0.03, 0.06, 0.04, a);
}
`;

export function createMongleActorRig(params: MongleActorRigParams): MongleActorRig {
  const group = new Group();
  const baseRgb = params.quaker ? QUAKER_PASTEL_TONES[params.quaker] : PLUSH_VIVID_TONES[params.tone];

  const charCenter = new Vector3();
  const mat = new ShaderMaterial({
    glslVersion: GLSL3,
    side: BackSide,
    transparent: true,
    depthWrite: true,
    uniforms: {
      uViewProj: { value: new Matrix4() },
      uCharCenter: { value: charCenter },
      uCharScale: { value: params.scale },
      uCharYaw: { value: 0 },
      uTime: { value: 0 },
      uPhase: { value: params.baseId * 1.73 },
      uFuzz: { value: 1.05 },
      uShape: { value: params.quaker ? 10 : MONGLE_SHAPE_CODE[params.shape] },
      uQuaker: { value: params.quaker ? QUAKER_MORPH_CODE[params.quaker] : 0 },
      uState: { value: 0 },
      uActivity: { value: 0 },
      uRole: { value: MONGLE_ROLE_CODE[params.role] },
      uBaseCol: { value: new Vector3(baseRgb[0], baseRgb[1], baseRgb[2]) },
      uWorldLightDir: { value: new Vector3(0.5, 0.85, 0.4) },
      uWorldTint: { value: new Vector3(1, 1, 1) },
    },
    vertexShader: ACTOR_VERTEX,
    fragmentShader: ACTOR_FRAGMENT,
  });

  const volumeMesh = new Mesh(sharedCubeGeo, mat);
  volumeMesh.frustumCulled = false;
  volumeMesh.renderOrder = 10;
  group.add(volumeMesh);

  // 보이지 않는 그림자 캐스터 코어
  const shadowMat = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const shadowCaster = new Mesh(sharedShadowSphereGeo, shadowMat);
  shadowCaster.castShadow = true;
  shadowCaster.scale.setScalar(params.scale);
  group.add(shadowCaster);

  // 발밑 소프트 그라데이션 밀착 접지 그림자 (Contact AO — 각진 테두리 없음)
  const contactMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    vertexShader: CONTACT_AO_VERTEX,
    fragmentShader: CONTACT_AO_FRAGMENT,
  });
  const contactDisc = new Mesh(sharedContactGeo, contactMat);
  contactDisc.scale.setScalar(params.scale);
  contactDisc.renderOrder = 2;
  group.add(contactDisc);

  // 발밑 3D 타깃/선택 링
  const ringMat = new MeshBasicMaterial({
    color: 0xfacc15,
    transparent: true,
    opacity: 0.82,
    side: DoubleSide,
    depthWrite: false,
  });
  const targetRing = new Mesh(sharedTargetRingGeo, ringMat);
  targetRing.visible = false;
  targetRing.renderOrder = 3;
  group.add(targetRing);

  // 결과 운반용 3D 선물 상자 & 승인 대기 다이아몬드 비콘
  const crateMat = new MeshStandardMaterial({ color: 0xfbbf24, emissive: 0xf59e0b, emissiveIntensity: 0.55, roughness: 0.35 });
  const crateMesh = new Mesh(sharedCrateGeo, crateMat);
  crateMesh.visible = false;
  group.add(crateMesh);

  const beaconMat = new MeshStandardMaterial({ color: 0xfde047, emissive: 0xfacc15, emissiveIntensity: 1.45, roughness: 0.22 });
  const beaconMesh = new Mesh(sharedBeaconGemGeo, beaconMat);
  beaconMesh.visible = false;
  group.add(beaconMesh);

  return {
    group,
    updatePose(opts) {
      const centerY = opts.groundY + opts.liftY + 0.62 * params.scale;
      charCenter.set(opts.x, centerY, opts.z);
      volumeMesh.position.copy(charCenter);
      shadowCaster.position.set(opts.x, centerY - 0.08 * params.scale, opts.z);
      contactDisc.position.set(opts.x, opts.groundY + 0.025, opts.z);

      const shrink = Math.max(0.45, 1 - opts.liftY * 0.45);
      contactDisc.scale.set(params.scale * shrink, params.scale * shrink, params.scale * shrink);

      // 선택 링 또는 [E] 근접 링 표시
      const showRing = Boolean(opts.isSelected || opts.isNearPlayer);
      targetRing.visible = showRing;
      if (showRing) {
        targetRing.position.set(opts.x, opts.groundY + 0.038, opts.z);
        const pulse = 1 + Math.sin(opts.elapsed * 4.2) * 0.06;
        targetRing.scale.setScalar(params.scale * pulse);
        ringMat.color.setHex(opts.isSelected ? 0xfacc15 : 0x38bdf8);
        ringMat.opacity = opts.isSelected ? 0.88 : 0.62;
      }

      mat.uniforms["uViewProj"]!.value = opts.viewProj;
      mat.uniforms["uCharYaw"]!.value = opts.yaw;
      mat.uniforms["uTime"]!.value = opts.elapsed;
      mat.uniforms["uFuzz"]!.value = opts.fuzz;
      mat.uniforms["uState"]!.value = MONGLE_STATE_CODE[opts.state];
      mat.uniforms["uActivity"]!.value = opts.activity ? MONGLE_ACTIVITY_CODE[opts.activity] : 0;
      (mat.uniforms["uWorldLightDir"]!.value as Vector3).copy(opts.sunDir);
      (mat.uniforms["uWorldTint"]!.value as Vector3).copy(opts.worldTint);

      crateMesh.visible = opts.carrying;
      if (opts.carrying) {
        crateMesh.position.set(opts.x, centerY + 0.85 * params.scale, opts.z);
        crateMesh.rotation.y = opts.elapsed * 2.5;
      }

      beaconMesh.visible = opts.needsAttention;
      if (opts.needsAttention) {
        beaconMesh.position.set(opts.x, centerY + 1.28 * params.scale + Math.sin(opts.elapsed * 5.2) * 0.12, opts.z);
        beaconMesh.rotation.y = opts.elapsed * 2.8;
        beaconMesh.scale.set(0.85, 1.35, 0.85);
      }
    },
    dispose() {
      mat.dispose();
      shadowMat.dispose();
      contactMat.dispose();
      ringMat.dispose();
      crateMat.dispose();
      beaconMat.dispose();
    },
  };
}
