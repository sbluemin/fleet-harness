import {
  DEFAULT_AVATAR_FUZZ,
  MAX_AVATAR_FUZZ,
  MIN_AVATAR_FUZZ,
  type MongleActivity,
  type MongleRole,
  type MongleShape,
  type MongleState,
  type QuakerMorph,
} from "../../shared/avatars.js";
import type { IdentityTone } from "../../shared/identity-tones.js";
import {
  MONGLE_ACTIVITY_CODE as ACTIVITY_CODE,
  MONGLE_BODY_GLSL,
  MONGLE_ROLE_CODE as ROLE_CODE,
  MONGLE_SDF_MATH_GLSL,
  MONGLE_SHAPE_CODE as SHAPE_CODE,
  MONGLE_STATE_CODE as STATE_CODE,
  PLUSH_VIVID_TONES,
  QUAKER_MORPH_CODE as QUAKER_CODE,
  QUAKER_PASTEL_TONES,
  type MongleRgb as Rgb,
} from "../../shared/mongle-3d-glsl.js";

/**
 * 3D 플러시 아바타 공용 WebGL2 렌더러.
 *
 * 일반 몽글(1–15)은 사령관에게 Plush Vivid, 지휘관·구성원에게 Fleet Pastel 팔레트를 역할에 따라 자동 적용하고
 * 미니멀 눈으로 그리며, 진급 퀘이커 사령관(토리·보리·도리)은 Fleet Pastel 팔레트 + 제독 모자·견장·날개짓을
 * 하나의 공유 오프스크린 WebGL2 컨텍스트로 렌더링해 각 아바타 캔버스에 복사한다.
 * 뷰포트 밖(IntersectionObserver)·숨은 탭·OS 감속 모션·「아바타 차분하게」·비포커스 감속을 모두 존중해
 * 목록에 아바타가 수십 개 서 있어도 GPU 비용을 낮게 유지한다.
 */

const MAX_GL_SIZE = 320;
const STEPPED_FRAME_INTERVAL_MS = 100;
const SMALL_IDLE_FRAME_INTERVAL_MS = 34;
const POSE_TRANSITION_MS = 380;

/** 일반 몽글 지휘관·구성원(1–15) 및 진급 퀘이커(토리·보리·도리) — Fleet Pastel 팔레트. */
const FLEET_PASTEL_TONES: Readonly<Record<IdentityTone, Rgb>> = {
  crimson:  [0.89, 0.60, 0.57],
  amber:    [0.94, 0.78, 0.55],
  moss:     [0.67, 0.84, 0.61],
  teal:     [0.58, 0.84, 0.81],
  cerulean: [0.58, 0.78, 0.93],
  indigo:   [0.68, 0.69, 0.92],
  plum:     [0.84, 0.68, 0.87],
  rose:     [0.92, 0.66, 0.76],
};

const CALLING_STATES: ReadonlySet<MongleState> = new Set(["awaiting", "decision", "review", "error"]);

const VERT_SRC = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = P[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform float uTime;
uniform float uTempo;
uniform float uPhase;
uniform float uFuzz;
uniform float uYaw;
uniform float uPitch;
uniform int   uShape;     // 0..9 mongle shapes, 10 = quaker
uniform int   uQuaker;    // 0=none, 1=tori, 2=bori, 3=dori
uniform int   uState;     // 0=idle,1=run,2=await,3=dec,4=rev,5=unseen,6=done,7=ended,8=err,9=fresh
uniform int   uActivity;  // 0=def,1=think,2=read,3=edit,4=run,5=fetch,6=delegate,7=text,8=compact,9=background
uniform int   uPrevState;
uniform int   uPrevActivity;
uniform float uTransBlend; // 0..1 상태/활동 전이 보간 진행도
uniform int   uRole;      // 0=commodore, 1=commander, 2=member
uniform int   uMini;      // 1 = mini tier (<=12px, simple squish without props/badges)
uniform int   uStatic;    // 1 = frozen resting pose (reduced-motion / calm / static idle)
uniform int   uLightBg;   // 1 = light theme ambient lift
uniform vec3  uBaseCol;

${MONGLE_SDF_MATH_GLSL}

struct AnimRig {
  vec3  offset;
  vec3  scale;
  float roll;
  float yawAdd;
  float pitchAdd;
  vec2  eyeShift;
  float eyeBlink;
  float floorGlow;
  float floorScale;
  float floorShiftX;
  float wingFlap;
};

AnimRig mixAnimRig(AnimRig a, AnimRig b, float k) {
  AnimRig r;
  r.offset = mix(a.offset, b.offset, k);
  r.scale = mix(a.scale, b.scale, k);
  r.roll = mix(a.roll, b.roll, k);
  r.yawAdd = mix(a.yawAdd, b.yawAdd, k);
  r.pitchAdd = mix(a.pitchAdd, b.pitchAdd, k);
  r.eyeShift = mix(a.eyeShift, b.eyeShift, k);
  r.eyeBlink = mix(a.eyeBlink, b.eyeBlink, k);
  r.floorGlow = mix(a.floorGlow, b.floorGlow, k);
  r.floorScale = mix(a.floorScale, b.floorScale, k);
  r.floorShiftX = mix(a.floorShiftX, b.floorShiftX, k);
  r.wingFlap = mix(a.wingFlap, b.wingFlap, k);
  return r;
}

AnimRig computeAnimFor(int state, int activity, float t) {
  AnimRig r;
  r.offset = vec3(0.0);
  r.scale = vec3(1.0);
  r.roll = 0.0;
  r.yawAdd = 0.0;
  r.pitchAdd = 0.0;
  r.eyeShift = vec2(0.0);
  r.eyeBlink = 1.0;
  r.floorGlow = 0.0;
  r.floorScale = 1.0;
  r.floorShiftX = 0.0;
  r.wingFlap = 0.0;

  if (uStatic == 1) {
    // 정지 자세 — 움직임을 꺼도 상태와 활동의 실루엣은 읽힌다.
    if (state == 1) {
      if (activity == 1) r.eyeShift = vec2(-0.04, 0.04);
      else if (activity == 2) r.eyeShift = vec2(0.0, -0.04);
      else if (activity == 3) { r.eyeShift = vec2(-0.03, -0.04); r.eyeBlink = 0.8; }
      else if (activity == 4) r.scale = vec3(1.05, 0.93, 1.02);
      else if (activity == 5) r.eyeShift = vec2(0.04, 0.025);
      else if (activity == 6) r.eyeShift = vec2(0.045, 0.0);
      else if (activity == 7) r.eyeBlink = 0.76;
      else if (activity == 8) { r.scale = vec3(0.90, 1.08, 0.94); r.eyeBlink = 0.36; }
      else if (activity == 9) r.eyeBlink = 0.56;
    } else if (state == 2) {
      r.eyeShift = vec2(0.0, 0.04);
      r.floorGlow = 0.85;
    } else if (state == 3) {
      r.roll = -0.14;
      r.eyeShift = vec2(-0.04, 0.0);
      r.floorGlow = 0.85;
      r.floorShiftX = -0.10;
    } else if (state == 4) {
      r.scale = vec3(0.95, 1.07, 1.0);
      r.offset.y = 0.04;
      r.floorGlow = 0.92;
      r.floorScale = 1.15;
    } else if (state == 6 || state == 7) {
      r.scale = vec3(1.06, 0.92, 1.03);
      r.offset.y = -0.05;
    }
    return r;
  }

  if (uQuaker > 0) {
    float wAmp = (state == 1 || state == 2) ? 0.30 : (state == 7 || state == 9 ? 0.03 : 0.14);
    float wSpd = (state == 1 || state == 2) ? 6.8 : 3.2;
    r.wingFlap = sin(t * wSpd) * wAmp;
  }

  if (uMini == 1) {
    if (state == 1) {
      float b = sin(t * 4.4);
      r.scale = vec3(1.0 + b * 0.06, 1.0 - b * 0.07, 1.0 + b * 0.04);
    }
    return r;
  }

  if (state == 0) {
    float breath = sin(t * 2.1);
    r.scale = vec3(1.0 + breath * 0.022, 1.0 - breath * 0.024, 1.0 + breath * 0.015);
    r.offset.y = sin(t * 1.45) * 0.030;
    r.roll = sin(t * 1.15) * 0.042;
    r.yawAdd = sin(t * 0.9) * 0.055;
    float bt = fract(t / 4.8);
    if (bt > 0.92 && bt < 0.98) {
      float bp = sin((bt - 0.92) / 0.06 * 3.14159);
      r.eyeBlink = mix(1.0, 0.10, bp);
    }
  } else if (state == 1) {
    r.roll = sin(t * 1.65) * 0.065;
    if (activity == 0) {
      float cyc = fract(t / 3.8);
      if (cyc < 0.72) {
        float b = sin(cyc / 0.72 * 3.14159 * 4.0);
        r.scale = vec3(1.0 + b * 0.06, 1.0 - b * 0.07, 1.0 + b * 0.04);
        r.offset.y = max(0.0, -b) * 0.05;
      } else {
        float hp = (cyc - 0.72) / 0.28;
        float jump = sin(hp * 3.14159);
        r.offset.y = jump * 0.19;
        r.scale = vec3(1.0 - jump * 0.07, 1.0 + jump * 0.09, 1.0 - jump * 0.05);
      }
      r.eyeShift = vec2(sin(t * 1.7) * 0.045, cos(t * 1.1) * 0.015);
      float bt = fract(t / 4.2);
      if (bt > 0.92 && bt < 0.98) r.eyeBlink = 0.12;
    } else if (activity == 1) {
      float w = sin(t * 2.2);
      r.roll = -0.14 + w * 0.06;
      r.pitchAdd = -0.06;
      r.scale = vec3(1.0 + w * 0.025, 1.0 - w * 0.025, 1.0);
      r.eyeShift = vec2(sin(t * 1.5) * 0.045, 0.045);
    } else if (activity == 2) {
      float scan = sin(t * 2.6);
      r.pitchAdd = 0.08 + sin(t * 5.2) * 0.025;
      r.scale = vec3(1.02, 0.98, 1.0);
      r.eyeShift = vec2(scan * 0.055, -0.04);
    } else if (activity == 3) {
      float w = sin(t * 7.8);
      r.scale = vec3(1.0 + w * 0.075, 1.0 - w * 0.085, 1.0 + w * 0.04);
      r.offset.y = max(0.0, -w) * 0.045;
      r.eyeShift = vec2(-0.02, -0.035);
      r.eyeBlink = 0.82;
    } else if (activity == 4) {
      float p = fract(t * 0.85);
      float j = sin(p * 3.14159);
      float sq = sin(p * 6.28318);
      r.offset.y = pow(j, 0.85) * 0.22;
      r.scale = vec3(1.0 - sq * 0.09, 1.0 + sq * 0.10, 1.0 - sq * 0.06);
      r.eyeBlink = (p < 0.18 || p > 0.82) ? 0.45 : 1.0;
    } else if (activity == 5) {
      float sc = sin(t * 2.6);
      r.offset.x = sc * 0.11;
      r.yawAdd = sc * 0.22;
      r.scale = vec3(0.97, 1.04, 1.0);
      r.eyeShift = vec2(sc * 0.055, 0.025);
    } else if (activity == 6) {
      float w = sin(t * 4.2);
      r.offset.y = max(0.0, w) * 0.09;
      r.scale = vec3(1.0 - w * 0.05, 1.0 + w * 0.06, 1.0);
      r.yawAdd = 0.14;
      r.eyeShift = vec2(0.045, 0.01);
    } else if (activity == 7) {
      float talk = abs(sin(t * 5.8));
      r.offset.y = talk * 0.065;
      r.scale = vec3(1.0 - talk * 0.035, 1.0 + talk * 0.045, 1.0);
      r.eyeBlink = 0.78;
    } else if (activity == 8) {
      float sq = 0.5 + 0.5 * sin(t * 3.8);
      r.scale = vec3(mix(1.05, 0.84, sq), mix(0.95, 1.12, sq), mix(1.02, 0.90, sq));
      r.roll = sin(t * 1.9) * 0.16;
      r.eyeBlink = mix(0.9, 0.32, sq);
    } else {
      // background: 느린 호흡과 반쯤 감은 눈
      float bg = sin(t * 2.2);
      r.scale = vec3(1.0 + bg * 0.045, 1.0 - bg * 0.05, 1.0 + bg * 0.02);
      r.eyeBlink = 0.56;
    }
  } else if (state == 2) {
    float cyc = fract(t / 2.2);
    float hop = 0.0;
    if (cyc < 0.22) hop = sin(cyc / 0.22 * 3.14159);
    else if (cyc > 0.26 && cyc < 0.44) hop = sin((cyc - 0.26) / 0.18 * 3.14159) * 0.62;
    r.offset.y = hop * 0.22;
    r.scale = vec3(1.0 - hop * 0.08, 1.0 + hop * 0.10, 1.0 - hop * 0.05);
    r.eyeShift = vec2(0.0, 0.04);
    r.floorGlow = 0.95 - hop * 0.45;
    r.floorScale = 1.05 - hop * 0.30;
  } else if (state == 3) {
    float sw = sin(t * 2.0);
    r.roll = sw * 0.19;
    r.yawAdd = sw * 0.12;
    r.eyeShift = vec2(sw * 0.04, 0.01);
    r.floorGlow = 0.85;
    r.floorShiftX = -sw * 0.12;
  } else if (state == 4) {
    float pr = 0.5 + 0.5 * sin(t * 2.1);
    r.scale = vec3(mix(1.03, 0.93, pr), mix(0.96, 1.09, pr), 1.0);
    r.offset.y = pr * 0.07;
    r.floorGlow = mix(0.65, 1.0, pr);
    r.floorScale = mix(0.95, 1.22, pr);
  } else if (state == 5) {
    float b = sin(t * 2.5);
    r.offset.y = b * 0.045 + 0.02;
    r.scale = vec3(1.0 - b * 0.025, 1.0 + b * 0.03, 1.0);
    r.roll = sin(t * 1.4) * 0.05;
  } else if (state == 6) {
    float b = sin(t * 1.5);
    r.scale = vec3(1.07 + b * 0.015, 0.91 - b * 0.015, 1.04);
    r.offset.y = -0.05;
  } else if (state == 7) {
    float sl = sin(t * 1.15);
    r.scale = vec3(1.05 + sl * 0.03, 0.92 - sl * 0.03, 1.03);
    r.offset.y = -0.06;
    r.pitchAdd = 0.08;
  } else if (state == 8) {
    float cyc = fract(t / 2.6);
    if (cyc < 0.22) {
      r.offset.x = sin(cyc * 95.0) * 0.055 * (1.0 - cyc / 0.22);
      r.roll = sin(cyc * 70.0) * 0.07;
    }
    r.scale = vec3(1.02, 0.97, 1.0);
  }

  return r;
}

AnimRig computeAnim() {
  float t = (uTime + uPhase) / max(uTempo, 0.5);
  AnimRig currRig = computeAnimFor(uState, uActivity, t);
  if (uStatic == 1 || uTransBlend >= 0.999 || (uPrevState == uState && uPrevActivity == uActivity)) {
    return currRig;
  }
  AnimRig prevRig = computeAnimFor(uPrevState, uPrevActivity, t);
  return mixAnimRig(prevRig, currRig, smoothstep(0.0, 1.0, clamp(uTransBlend, 0.0, 1.0)));
}

${MONGLE_BODY_GLSL}

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

float thoughtBubbleScale(float cyc, float inA, float inB, float outA, float outB, float bounceAmp) {
  if (cyc < inA || cyc > outB) return 0.0;
  float popIn = smoothstep(inA, inB, cyc);
  float elastic = popIn + sin(popIn * 3.1415926) * bounceAmp * (1.0 - smoothstep(inB, inB + 0.09, cyc));
  float shrinkOut = 1.0 - smoothstep(outA, outB, cyc);
  return max(0.0, elastic * shrinkOut);
}

vec2 mapActivityProps(vec2 res, vec3 q, float sMin, float t, int state, int activity, float propScale) {
  if (state != 1 || activity == 0 || propScale <= 0.02) return res;
  float ps = clamp(propScale, 0.02, 1.2);
  if (activity == 1) {
    // 생각 중 말풍선 1→2→3 점진적 생성 루프 (약 2.4초 주기, uStatic==1일 땐 3개 정지 표시)
    float cyc = fract(t * 0.42);
    float b1 = (uStatic == 1) ? 1.0 : thoughtBubbleScale(cyc, 0.02, 0.15, 0.80, 0.92, 0.22);
    float b2 = (uStatic == 1) ? 1.0 : thoughtBubbleScale(cyc, 0.20, 0.34, 0.83, 0.95, 0.24);
    float b3 = (uStatic == 1) ? 1.0 : thoughtBubbleScale(cyc, 0.38, 0.54, 0.86, 0.98, 0.28);
    float s1 = b1 * ps;
    float s2 = b2 * ps;
    float s3 = b3 * ps;
    float pulse = (uStatic == 1) ? 0.0 : sin(t * 3.8) * 0.022;
    float cloudBounce = (uStatic == 1) ? 0.0 : sin(clamp((cyc - 0.38) / 0.16, 0.0, 1.0) * 3.1415926) * 0.032;
    float dBub = 1e5;
    if (s1 > 0.02) dBub = min(dBub, sdSphere(q - vec3(0.46, 0.42 + pulse, 0.24), 0.048 * s1));
    if (s2 > 0.02) dBub = min(dBub, sdSphere(q - vec3(0.58, 0.56 + pulse * 1.4, 0.22), 0.072 * s2));
    if (s3 > 0.02) dBub = min(dBub, sdSphere(q - vec3(0.74, 0.72 + pulse * 1.8 + cloudBounce, 0.20), 0.105 * s3));
    if (dBub < 1e4) res = opU(res, vec2(dBub * sMin, 3.0));
    float tap = (uStatic == 1) ? 0.0 : abs(sin(t * 4.5)) * 0.045;
    float hand = sdSphere(q - vec3(-0.22, -0.34 + tap, 0.48), 0.11 * ps);
    res = opU(res, vec2(hand * sMin, 7.0));
  } else if (activity == 2) {
    vec3 bp = (q - vec3(0.0, -0.38, 0.56)) / ps;
    bp.yz = rot2(0.32) * bp.yz;
    vec3 pL = bp - vec3(-0.18, 0.0, 0.02); pL.xz = rot2(-0.28) * pL.xz;
    vec3 pR = bp - vec3( 0.18, 0.0, 0.02); pR.xz = rot2( 0.28) * pR.xz;
    float book = min(sdRoundBox(pL, vec3(0.17, 0.135, 0.02), 0.015),
                     sdRoundBox(pR, vec3(0.17, 0.135, 0.02), 0.015)) * ps;
    res = opU(res, vec2(book * sMin, 3.0));
    float hL = sdSphere(q - vec3(-0.35, -0.42, 0.56), 0.10 * ps);
    float flip = (uStatic == 1) ? 0.0 : max(0.0, sin(t * 2.8)) * 0.09;
    float hR = sdSphere(q - vec3( 0.35, -0.42 + flip, 0.56), 0.10 * ps);
    res = opU(res, vec2(min(hL, hR) * sMin, 7.0));
  } else if (activity == 3) {
    vec3 np = (q - vec3(-0.30, -0.42, 0.54)) / ps;
    np.yz = rot2(0.22) * np.yz;
    float pad = sdRoundBox(np, vec3(0.19, 0.135, 0.022), 0.016) * ps;
    res = opU(res, vec2(pad * sMin, 3.0));
    vec3 sc = (uStatic == 1) ? vec3(0.0) : vec3(sin(t * 14.0) * 0.05, cos(t * 11.0) * 0.035, 0.0);
    vec3 pp = (q - (vec3(0.18, -0.30, 0.58) + sc)) / ps;
    pp.xy = rot2(-0.72) * pp.xy;
    float pencil = sdCapsule(pp, vec3(-0.23, 0.0, 0.0), vec3(0.23, 0.0, 0.0), 0.046) * ps;
    res = opU(res, vec2(pencil * sMin, 6.0));
    float hand = sdSphere(q - (vec3(0.26, -0.25, 0.56) + sc * 0.8), 0.10 * ps);
    res = opU(res, vec2(hand * sMin, 7.0));
  } else if (activity == 4) {
    float lift = (uStatic == 1) ? 0.04 : sin(t * 5.2) * 0.12;
    float hL = sdSphere(q - vec3(-0.74, 0.08 + lift, 0.18), 0.12 * ps);
    float hR = sdSphere(q - vec3( 0.74, 0.08 + lift, 0.18), 0.12 * ps);
    res = opU(res, vec2(min(hL, hR) * sMin, 7.0));
  } else if (activity == 5) {
    vec3 tp = (q - vec3(0.46, 0.04, 0.44)) / ps;
    tp.xy = rot2(0.32 + ((uStatic == 1) ? 0.0 : sin(t * 2.6) * 0.25)) * tp.xy;
    float tube = sdRoundCone(tp, vec3(-0.18, 0.0, 0.0), vec3(0.28, 0.0, 0.0), 0.055, 0.095) * ps;
    float lens = sdEllipsoid(tp - vec3(0.29, 0.0, 0.0), vec3(0.03, 0.09, 0.09)) * ps;
    res = opU(res, vec2(tube * sMin, 5.0));
    res = opU(res, vec2(lens * sMin, 3.0));
    float hand = sdSphere(q - vec3(0.44, -0.10, 0.45), 0.105 * ps);
    res = opU(res, vec2(hand * sMin, 7.0));
  } else if (activity == 6) {
    vec3 wp = (q - vec3(0.66, 0.26, 0.22)) / ps;
    wp.xy = rot2((uStatic == 1) ? 0.18 : sin(t * 6.5) * 0.35) * wp.xy;
    float hand = sdSphere(wp - vec3(0.05, 0.08, 0.0), 0.125) * ps;
    res = opU(res, vec2(hand * sMin, 7.0));
  } else if (activity == 7) {
    vec3 sp = (q - vec3(0.56, 0.62 + ((uStatic == 1) ? 0.0 : sin(t * 4.2) * 0.03), 0.24)) / ps;
    float bub = sdRoundBox(sp, vec3(0.18, 0.10, 0.04), 0.09);
    float tail = sdSphere(sp - vec3(-0.12, -0.14, 0.0), 0.055);
    res = opU(res, vec2(smin(bub, tail, 0.05) * ps * sMin, 3.0));
    float gL = (uStatic == 1) ? 0.0 : max(0.0, sin(t * 5.8)) * 0.14;
    float gR = (uStatic == 1) ? 0.0 : max(0.0, -sin(t * 5.8)) * 0.14;
    float hL = sdSphere(q - vec3(-0.62, -0.22 + gL, 0.32), 0.11 * ps);
    float hR = sdSphere(q - vec3( 0.62, -0.22 + gR, 0.32), 0.11 * ps);
    res = opU(res, vec2(min(hL, hR) * sMin, 7.0));
  } else if (activity == 8) {
    float sq = (uStatic == 1) ? 0.65 : (0.5 + 0.5 * sin(t * 3.8));
    float hx = mix(0.76, 0.58, sq);
    float hL = sdSphere(q - vec3(-hx, -0.05, 0.22), 0.12 * ps);
    float hR = sdSphere(q - vec3( hx, -0.05, 0.22), 0.12 * ps);
    res = opU(res, vec2(min(hL, hR) * sMin, 7.0));
  }
  return res;
}

vec2 mapStateBadge(vec2 res, vec3 p, float t, int state, float propScale) {
  if (propScale <= 0.02) return res;
  float ps = clamp(propScale, 0.02, 1.2);
  if (state == 5) {
    vec3 sp = (p - vec3(0.68, 0.62 + ((uStatic == 1) ? 0.0 : sin(t * 3.0) * 0.04), 0.25)) / ps;
    sp.xz = rot2((uStatic == 1) ? 0.2 : t * 1.4) * sp.xz;
    float pulse = (uStatic == 1) ? 1.0 : (0.85 + 0.20 * sin(t * 3.6));
    sp /= pulse;
    float s1 = sdEllipsoid(sp, vec3(0.16, 0.048, 0.055));
    float s2 = sdEllipsoid(sp, vec3(0.048, 0.16, 0.055));
    float s3 = sdEllipsoid(sp, vec3(0.055, 0.055, 0.12));
    res = opU(res, vec2(smin(min(s1, s2), s3, 0.03) * pulse * ps, 8.0));
  } else if (state == 8) {
    vec3 dp = (p - vec3(0.66, 0.56 - ((uStatic == 1) ? 0.0 : abs(sin(t * 2.5)) * 0.07), 0.26)) / ps;
    float drop = sdRoundCone(dp, vec3(0.0, -0.06, 0.0), vec3(0.0, 0.14, 0.0), 0.095, 0.018) * ps;
    res = opU(res, vec2(drop, 9.0));
  } else if (state == 7) {
    vec3 zp = (p - vec3(0.64, 0.56 + ((uStatic == 1) ? 0.0 : sin(t * 1.4) * 0.05), 0.25)) / ps;
    float z1 = sdCapsule(zp, vec3(-0.09,  0.09, 0.0), vec3( 0.09,  0.09, 0.0), 0.028);
    float z2 = sdCapsule(zp, vec3( 0.09,  0.09, 0.0), vec3(-0.09, -0.09, 0.0), 0.028);
    float z3 = sdCapsule(zp, vec3(-0.09, -0.09, 0.0), vec3( 0.09, -0.09, 0.0), 0.028);
    res = opU(res, vec2(min(z1, min(z2, z3)) * ps, 10.0));
  }
  return res;
}

vec2 mapScene(vec3 p, AnimRig rig) {
  vec3 q = toLocal(p, rig);
  float sMin = min(rig.scale.x, min(rig.scale.y, rig.scale.z));
  float t = (uStatic == 1) ? 0.0 : ((uTime + uPhase) / max(uTempo, 0.5));

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

    vec3 el = pq - vec3(-0.38, -0.39, 0.06);
    el.xy = rot2(0.32) * el.xy;
    float depL = sdRoundBox(el, vec3(0.105, 0.036, 0.072), 0.024) * sMin;
    vec3 er = pq - vec3(0.38, -0.39, 0.06);
    er.xy = rot2(-0.32) * er.xy;
    float depR = sdRoundBox(er, vec3(0.105, 0.036, 0.072), 0.024) * sMin;
    res = opU(res, vec2(min(depL, depR), 4.0));

    vec3 bp = pq - vec3(0.0, -0.16, 0.47);
    float dBeak = sdRoundCone(bp, vec3(0.0, 0.048, -0.02), vec3(0.0, -0.082, 0.105), 0.090, 0.030) * sMin;
    res = opU(res, vec2(dBeak, 6.0));

    vec3 cp = pq - vec3(0.0, 0.41, 0.0);
    cp.yz = rot2(-0.14) * cp.yz;

    float saucer = sdEllipsoid(cp - vec3(0.0, 0.17, -0.02), vec3(0.55, 0.165, 0.49));
    float crest  = sdEllipsoid(cp - vec3(0.0, 0.22,  0.22), vec3(0.26, 0.12,  0.22));
    float crown  = smin(saucer, crest, 0.10);
    res = opU(res, vec2(crown * sMin, 3.0));

    float band = sdEllipsoid(cp - vec3(0.0, -0.015, 0.0), vec3(0.45, 0.092, 0.42));
    res = opU(res, vec2(band * sMin, 5.0));

    vec3 vp = cp - vec3(0.0, -0.095, 0.30);
    vp.yz = rot2(0.24) * vp.yz;
    float visor = sdEllipsoid(vp, vec3(0.30, 0.040, 0.185));
    res = opU(res, vec2(visor * sMin, 2.0));

    vec3 ap = cp - vec3(0.0, 0.055, 0.435);
    float ancStem = sdCapsule(ap, vec3(0.0, -0.055, 0.0), vec3(0.0, 0.055, 0.0), 0.017);
    float ancBar  = sdCapsule(ap, vec3(-0.044, 0.02, 0.0), vec3(0.044, 0.02, 0.0), 0.014);
    float ancArcL = sdCapsule(ap, vec3(0.0, -0.055, 0.0), vec3(-0.058, -0.022, -0.01), 0.016);
    float ancArcR = sdCapsule(ap, vec3(0.0, -0.055, 0.0), vec3( 0.058, -0.022, -0.01), 0.016);
    float cord    = sdCapsule(cp - vec3(0.0, -0.058, 0.41), vec3(-0.24, 0.018, -0.06), vec3(0.24, 0.018, -0.06), 0.017);
    float btnL    = sdSphere(cp - vec3(-0.25, -0.04, 0.35), 0.030);
    float btnR    = sdSphere(cp - vec3( 0.25, -0.04, 0.35), 0.030);
    float dBrass  = min(min(min(ancStem, ancBar), min(ancArcL, ancArcR)), min(cord, min(btnL, btnR)));
    res = opU(res, vec2(dBrass * sMin, 4.0));
  } else if (uMini == 0) {
    if (uRole == 0) {
      vec3 sp = q - vec3(-0.56, 0.54, 0.22);
      sp.yz = rot2(0.08) * sp.yz;
      sp.xz = rot2(-0.18) * sp.xz;
      float plate = sdEllipsoid(sp, vec3(0.185, 0.185, 0.068));
      res = opU(res, vec2(plate * sMin, 4.0));
    } else if (uRole == 1) {
      float topY = shapeCrownY(uShape);
      float sway = (uStatic == 1) ? 0.0 : sin(t * 3.0) * 0.04;
      vec3 tip = vec3(sway, topY + 0.27, 0.0);
      float stalk = sdCapsule(q, vec3(0.0, topY - 0.06, 0.0), tip, 0.032);
      float bulb  = sdSphere(q - tip, 0.115);
      res = opU(res, vec2(stalk * sMin, 5.0));
      res = opU(res, vec2(bulb * sMin, 6.0));
    }

    if (uStatic == 1 || uTransBlend >= 0.999 || (uPrevState == uState && uPrevActivity == uActivity)) {
      res = mapActivityProps(res, q, sMin, t, uState, uActivity, 1.0);
    } else {
      float tb = smoothstep(0.0, 1.0, clamp(uTransBlend, 0.0, 1.0));
      float scaleOut = 1.0 - smoothstep(0.0, 0.65, tb);
      float scaleIn = smoothstep(0.25, 1.0, tb);
      res = mapActivityProps(res, q, sMin, t, uPrevState, uPrevActivity, scaleOut);
      res = mapActivityProps(res, q, sMin, t, uState, uActivity, scaleIn);
    }
  }

  if (uMini == 0) {
    if (uStatic == 1 || uTransBlend >= 0.999 || uPrevState == uState) {
      res = mapStateBadge(res, p, t, uState, 1.0);
    } else {
      float tb = smoothstep(0.0, 1.0, clamp(uTransBlend, 0.0, 1.0));
      res = mapStateBadge(res, p, t, uPrevState, 1.0 - smoothstep(0.0, 0.65, tb));
      res = mapStateBadge(res, p, t, uState, smoothstep(0.25, 1.0, tb));
    }
  }

  return res;
}

vec3 calcNormal(vec3 p, AnimRig rig) {
  vec2 e = vec2(0.0024, -0.0024);
  return normalize(
    e.xyy * mapScene(p + e.xyy, rig).x +
    e.yyx * mapScene(p + e.yyx, rig).x +
    e.yxy * mapScene(p + e.yxy, rig).x +
    e.xxx * mapScene(p + e.xxx, rig).x
  );
}

vec3 calcPlushGrad(vec3 p, AnimRig rig) {
  vec2 e = vec2(0.004, -0.004);
  return normalize(
    e.xyy * sdPlushOnly(p + e.xyy, rig) +
    e.yyx * sdPlushOnly(p + e.yyx, rig) +
    e.yxy * sdPlushOnly(p + e.yxy, rig) +
    e.xxx * sdPlushOnly(p + e.xxx, rig)
  );
}

float calcAO(vec3 pos, vec3 nor, AnimRig rig) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 4; i++) {
    float h = 0.035 + 0.075 * float(i);
    float d = mapScene(pos + h * nor, rig).x;
    occ += (h - d) * sca;
    sca *= 0.68;
  }
  return clamp(1.0 - 2.1 * occ, 0.25, 1.0);
}

struct FaceSample {
  float eyeMask;
  float eyeRingMask;
  float eyeGlint;
  float eyeRimAO;
  float blushMask;
  vec2  eyeLocal;
};

FaceSample sampleFace(vec3 q, vec3 norLocal, AnimRig rig) {
  FaceSample f;
  f.eyeMask = 0.0;
  f.eyeRingMask = 0.0;
  f.eyeGlint = 0.0;
  f.eyeRimAO = 0.0;
  f.blushMask = 0.0;
  f.eyeLocal = vec2(0.0);

  if (q.z < 0.08 || norLocal.z < 0.14) return f;
  float frontFade = smoothstep(0.14, 0.34, norLocal.z);

  if (uQuaker > 0) {
    vec3 pq = q - vec3(0.0, 0.08, 0.0);
    vec2 ep = pq.xy - vec2(0.0, -0.015) - rig.eyeShift * 0.55;
    vec2 eL = ep - vec2(-0.185, 0.0);
    vec2 eR = ep - vec2( 0.185, 0.0);
    vec2 eLb = vec2(eL.x, eL.y / max(rig.eyeBlink, 0.10));
    vec2 eRb = vec2(eR.x, eR.y / max(rig.eyeBlink, 0.10));
    float dRing = min(length(eLb), length(eRb)) - 0.112;
    float dPupil = min(length(eLb), length(eRb)) - 0.090;

    if (uState == 5 || uState == 6) {
      float aL = abs(eL.y - (0.045 - 6.5 * eL.x * eL.x));
      float aR = abs(eR.y - (0.045 - 6.5 * eR.x * eR.x));
      float dArc = min(max(aL, abs(eL.x) - 0.088), max(aR, abs(eR.x) - 0.088)) - 0.022;
      f.eyeMask = (1.0 - smoothstep(-0.008, 0.010, dArc)) * frontFade;
    } else if (uState == 7) {
      float dSl = min(sdSeg2(eL, vec2(-0.08,0.0), vec2(0.08,0.0)), sdSeg2(eR, vec2(-0.08,0.0), vec2(0.08,0.0))) - 0.022;
      f.eyeMask = (1.0 - smoothstep(-0.008, 0.010, dSl)) * frontFade;
    } else if (uState == 8) {
      float xL = min(sdSeg2(eL, vec2(-0.06,-0.06), vec2(0.06,0.06)), sdSeg2(eL, vec2(-0.06,0.06), vec2(0.06,-0.06)));
      float xR = min(sdSeg2(eR, vec2(-0.06,-0.06), vec2(0.06,0.06)), sdSeg2(eR, vec2(-0.06,0.06), vec2(0.06,-0.06)));
      f.eyeMask = (1.0 - smoothstep(-0.008, 0.010, min(xL, xR) - 0.020)) * frontFade;
    } else {
      f.eyeRingMask = (1.0 - smoothstep(-0.008, 0.008, dRing)) * frontFade;
      f.eyeMask = (1.0 - smoothstep(-0.008, 0.008, dPupil)) * frontFade;
      f.eyeRimAO = (1.0 - smoothstep(0.0, 0.050, max(dRing, 0.0))) * frontFade;
      vec2 nearE = (length(eLb) < length(eRb)) ? eLb : eRb;
      f.eyeLocal = nearE / 0.090;
      float g1 = 1.0 - smoothstep(0.024, 0.034, length(nearE - vec2(-0.028, 0.028)));
      float g2 = (1.0 - smoothstep(0.012, 0.019, length(nearE - vec2(0.028, -0.026)))) * 0.72;
      f.eyeGlint = clamp(g1 + g2, 0.0, 1.0) * f.eyeMask;
    }

    if (uQuaker != 2 && uState != 7 && uState != 9) {
      float bL = length((pq.xy - vec2(-0.29, -0.18)) / vec2(0.095, 0.058));
      float bR = length((pq.xy - vec2( 0.29, -0.18)) / vec2(0.095, 0.058));
      f.blushMask = (1.0 - smoothstep(0.30, 1.0, min(bL, bR))) * 0.48 * frontFade;
    }
    return f;
  }

  // 일반 몽글 — 미니멀 눈만 적용 (레퍼런스 플러시 스타일)
  float eyeY = (uShape == 4) ? -0.10 : (uShape == 9 ? -0.04 : 0.01);
  vec2 ep = q.xy - vec2(0.0, eyeY) - rig.eyeShift;
  float sep = 0.182;
  vec2 eL = ep - vec2(-sep, 0.0);
  vec2 eR = ep - vec2( sep, 0.0);

  if (uState == 5 || uState == 6) {
    float aL = abs(eL.y - (0.048 - 5.6 * eL.x * eL.x));
    float aR = abs(eR.y - (0.048 - 5.6 * eR.x * eR.x));
    float dArc = min(max(aL, abs(eL.x) - 0.090), max(aR, abs(eR.x) - 0.090)) - 0.025;
    f.eyeMask = (1.0 - smoothstep(-0.008, 0.010, dArc)) * frontFade;
  } else if (uState == 7) {
    float dSl = min(sdSeg2(eL, vec2(-0.082,0.0), vec2(0.082,0.0)), sdSeg2(eR, vec2(-0.082,0.0), vec2(0.082,0.0))) - 0.025;
    f.eyeMask = (1.0 - smoothstep(-0.008, 0.010, dSl)) * frontFade;
  } else if (uState == 8) {
    float xL = min(sdSeg2(eL, vec2(-0.065,-0.065), vec2(0.065,0.065)), sdSeg2(eL, vec2(-0.065,0.065), vec2(0.065,-0.065)));
    float xR = min(sdSeg2(eR, vec2(-0.065,-0.065), vec2(0.065,0.065)), sdSeg2(eR, vec2(-0.065,0.065), vec2(0.065,-0.065)));
    f.eyeMask = (1.0 - smoothstep(-0.008, 0.010, min(xL, xR) - 0.023)) * frontFade;
  } else if (uState == 9) {
    // fresh: 작은 점눈
    float dDot = min(length(eL), length(eR)) - 0.052;
    f.eyeMask = (1.0 - smoothstep(-0.008, 0.009, dDot)) * frontFade;
  } else {
    float wL = 0.078, hL = 0.128;
    float wR = 0.078, hR = 0.128;
    if (uState == 2) { wL = 0.094; hL = 0.104; wR = 0.094; hR = 0.104; }
    if (uState == 3) { wL = 0.074; hL = 0.080; wR = 0.106; hR = 0.114; }
    if (uState == 4) { wL = 0.096; hL = 0.106; wR = 0.096; hR = 0.106; }
    if (uState == 1) { hL *= 0.92; hR *= 0.92; }
    hL = max(0.018, hL * rig.eyeBlink);
    hR = max(0.018, hR * rig.eyeBlink);

    float dL = sdRoundedBox2(eL, vec2(wL, hL), min(wL, hL) * 0.96);
    float dR = sdRoundedBox2(eR, vec2(wR, hR), min(wR, hR) * 0.96);
    float dEye = min(dL, dR);

    f.eyeMask = (1.0 - smoothstep(-0.008, 0.009, dEye)) * frontFade;
    f.eyeRimAO = (1.0 - smoothstep(0.0, 0.052, max(dEye, 0.0))) * frontFade;

    vec2 nearE = (dL < dR) ? (eL / vec2(wL, hL)) : (eR / vec2(wR, hR));
    f.eyeLocal = nearE;

    if (uState == 4) {
      float g = 1.0 - smoothstep(0.20, 0.36, length(nearE - vec2(-0.28, 0.30)));
      f.eyeGlint = g * f.eyeMask;
    }
  }

  return f;
}

vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0005)), vec3(2.2)); }

vec3 shadePlush(vec3 p, vec3 q, vec3 N, vec3 V, vec3 baseColSRGB, float ao, AnimRig rig, bool isWing) {
  vec3 baseCol = toLinear(baseColSRGB);
  float fAmt = 0.28 * clamp(uFuzz, 0.0, 1.5);
  vec3 fp = q * 38.0;
  float n0 = noise3(fp);
  vec3 fGrad = vec3(
    noise3(fp + vec3(0.18, 0.0, 0.0)) - n0,
    noise3(fp + vec3(0.0, 0.18, 0.0)) - n0,
    noise3(fp + vec3(0.0, 0.0, 0.18)) - n0
  );
  float fineGrain = noise3(q * 110.0) - 0.5;
  vec3 Nf = normalize(N + fGrad * (2.2 * fAmt));

  vec3 L1 = normalize(vec3(-0.62, 0.82, 0.80));
  vec3 L2 = normalize(vec3( 0.72,-0.22, 0.52));
  vec3 L3 = normalize(vec3( 0.48, 0.70,-0.80));

  float diff1 = clamp((dot(Nf, L1) + 0.36) / 1.36, 0.0, 1.0);
  float diff2 = clamp((dot(Nf, L2) + 0.30) / 1.30, 0.0, 1.0);

  vec3 deepCol = pow(max(baseCol, vec3(0.002)), vec3(1.38)) * 0.14;
  vec3 hiCol   = baseCol * 1.18 + vec3(0.035);

  vec3 col = mix(deepCol, hiCol, pow(diff1, 1.08));
  col += baseCol * diff2 * 0.16;

  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float velvet = pow(1.0 - ndv, 2.5);
  float rimBack = pow(clamp(dot(N, L3) * 0.5 + 0.5, 0.0, 1.0), 1.8) * velvet;
  vec3 sheenCol = mix(baseCol, vec3(1.0), 0.28);
  col += sheenCol * (velvet * 0.24 + rimBack * 0.44) * (0.60 + 0.40 * clamp(uFuzz, 0.0, 1.5));

  col *= (1.0 + fineGrain * 0.14 * clamp(uFuzz, 0.0, 1.5));

  if (rig.floorGlow > 0.01) {
    float downFace = clamp(-N.y * 0.65 + 0.35, 0.0, 1.0);
    col += vec3(0.06, 0.72, 0.92) * downFace * rig.floorGlow * 0.28;
  }

  if (uLightBg == 1) {
    col += vec3(0.04) * clamp(-N.y, 0.0, 1.0);
  }

  col *= mix(0.45, 1.0, ao);
  if (isWing) col *= 0.86;
  return col;
}

vec3 shadeSolidMat(int matId, vec3 p, vec3 q, vec3 N, vec3 V, float ao) {
  vec3 L1 = normalize(vec3(-0.62, 0.82, 0.80));
  vec3 L3 = normalize(vec3( 0.48, 0.70,-0.80));
  vec3 H1 = normalize(L1 + V);
  float ndl = max(dot(N, L1), 0.0);
  float wrap = clamp((dot(N, L1) + 0.32) / 1.32, 0.0, 1.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);

  if (matId == 2) {
    vec3 base = toLinear(vec3(0.11, 0.13, 0.20));
    float spec = pow(max(dot(N, H1), 0.0), 46.0);
    return (base * (0.35 + 0.95 * wrap) + vec3(0.75, 0.82, 1.0) * spec * 0.42 + vec3(0.10, 0.14, 0.24) * fres * 0.35) * ao;
  } else if (matId == 3) {
    vec3 base = toLinear(vec3(0.94, 0.93, 0.90));
    float spec = pow(max(dot(N, H1), 0.0), 16.0);
    return (base * (0.30 + 0.78 * wrap) + vec3(1.0) * spec * 0.10 + vec3(0.75, 0.80, 0.90) * fres * 0.15) * ao;
  } else if (matId == 4) {
    vec3 gold = toLinear(vec3(0.95, 0.72, 0.26));
    vec3 darkGold = toLinear(vec3(0.38, 0.24, 0.06));
    float spec = pow(max(dot(N, H1), 0.0), 32.0);
    float rim = pow(max(dot(N, L3), 0.0), 3.0);
    vec3 col = mix(darkGold, gold, 0.22 + 0.88 * wrap) + vec3(1.0, 0.88, 0.56) * spec * 0.85 + gold * rim * 0.40;
    if (uQuaker == 0 && uRole == 0) {
      vec3 sp = q - vec3(-0.56, 0.54, 0.22);
      sp.yz = rot2(0.08) * sp.yz;
      sp.xz = rot2(-0.18) * sp.xz;
      if (sp.z > 0.02) {
        float dStar = sdStar5_2D(vec2(sp.x, -sp.y), 0.132, 0.45);
        float sm = 1.0 - smoothstep(-0.008, 0.008, dStar);
        col = mix(col, vec3(0.012, 0.010, 0.018), sm * 0.96);
      }
    }
    return col * ao;
  } else if (matId == 5) {
    vec3 base = toLinear(vec3(0.16, 0.20, 0.30));
    float spec = pow(max(dot(N, H1), 0.0), 22.0);
    return (base * (0.32 + 0.82 * wrap) + vec3(0.45, 0.54, 0.72) * spec * 0.24 + vec3(0.15, 0.22, 0.38) * fres * 0.25) * ao;
  } else if (matId == 6) {
    vec3 base = toLinear((uQuaker > 0) ? vec3(0.97, 0.67, 0.30) : vec3(0.99, 0.84, 0.32));
    float spec = pow(max(dot(N, H1), 0.0), 28.0);
    return (base * (0.30 + 0.82 * wrap) + vec3(1.0, 0.94, 0.80) * spec * 0.40 + vec3(0.95, 0.80, 0.45) * fres * 0.20) * ao;
  } else if (matId == 8) {
    vec3 base = toLinear(vec3(0.18, 0.92, 0.52));
    return base * (0.65 + 0.55 * ndl) + vec3(0.55, 1.0, 0.75) * (fres * 0.55 + 0.20);
  } else if (matId == 9) {
    vec3 base = toLinear(vec3(0.99, 0.60, 0.14));
    float spec = pow(max(dot(N, H1), 0.0), 40.0);
    return base * (0.42 + 0.72 * wrap) + vec3(1.0, 0.92, 0.72) * spec * 0.85 + vec3(1.0, 0.75, 0.30) * fres * 0.30;
  } else {
    vec3 base = toLinear(vec3(0.60, 0.65, 0.76));
    return base * (0.45 + 0.65 * wrap) + vec3(0.75, 0.82, 0.95) * fres * 0.22;
  }
}

vec3 plushColorAt(vec3 q, bool isWing) {
  vec3 col = uBaseCol;
  if (uQuaker > 0) {
    // 진급 사령관 3종 — Fleet Pastel 팔레트
    if (uQuaker == 1) {
      col = isWing ? mix(uBaseCol, vec3(0.32, 0.52, 0.34), 0.28) : uBaseCol;
    } else if (uQuaker == 2) {
      col = isWing ? vec3(0.92, 0.89, 0.88) : vec3(0.95, 0.93, 0.92);
    } else {
      col = isWing ? mix(uBaseCol, vec3(0.32, 0.52, 0.72), 0.26) : uBaseCol;
    }
    vec3 pq = q - vec3(0.0, 0.08, 0.0);
    float bibFace = 1.0 - smoothstep(0.26, 0.40, length((pq.xy - vec2(0.0, -0.23)) / vec2(0.90, 0.60)));
    float bibChest = 1.0 - smoothstep(0.25, 0.37, length((pq.xy - vec2(0.0, -0.55)) / vec2(0.84, 0.78)));
    float bibMask = max(bibFace, bibChest) * smoothstep(0.05, 0.26, pq.z);
    vec3 bibCol = (uQuaker == 2) ? vec3(0.99, 0.98, 0.97) : mix(col, vec3(0.96, 0.96, 0.94), 0.78);
    if (!isWing) col = mix(col, bibCol, bibMask);
  } else if (isWing) {
    col = mix(col, vec3(0.14, 0.14, 0.20), 0.16);
  }

  if (uState == 6 || uState == 7) {
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(lum * 0.78 + 0.14), 0.48);
  } else if (uState == 9) {
    col = mix(col, vec3(0.86, 0.88, 0.92), 0.42);
  }
  return col;
}

void main() {
  vec2 uv = (vUv - 0.5) * 2.0;

  float camDist = 3.12;
  vec3 ro = vec3(0.0, 0.05, camDist);
  vec3 rd = normalize(vec3(uv * 0.90, -2.55));

  mat2 rP = rot2(uPitch);
  mat2 rY = rot2(uYaw);
  ro.yz = rP * ro.yz; rd.yz = rP * rd.yz;
  ro.xz = rY * ro.xz; rd.xz = rY * rd.xz;

  AnimRig rig = computeAnim();

  vec3 floorCol = vec3(0.0);
  float floorAlpha = 0.0;
  if (rd.y < -0.001 && uMini == 0) {
    float tf = (-0.80 - ro.y) / rd.y;
    if (tf > 0.0 && tf < 10.0) {
      vec3 fp = ro + rd * tf;
      float shR = length((fp.xz - vec2(rig.offset.x, 0.0)) / vec2(0.68, 0.58));
      float sh = exp(-shR * shR * 2.6) * (0.36 - clamp(rig.offset.y, 0.0, 0.3) * 0.75);
      vec3 shCol = (uLightBg == 1) ? vec3(0.16, 0.18, 0.25) : vec3(0.0, 0.0, 0.02);
      floorCol = shCol;
      floorAlpha = clamp(sh * (uLightBg == 1 ? 0.38 : 0.55), 0.0, 0.55);

      if (rig.floorGlow > 0.01) {
        vec2 gp = (fp.xz - vec2(rig.floorShiftX, 0.0)) / vec2(0.76 * rig.floorScale, 0.42 * rig.floorScale);
        float g = exp(-dot(gp, gp) * 2.2) * rig.floorGlow;
        vec3 aurora = vec3(0.24, 0.88, 0.98);
        floorCol = mix(floorCol, aurora, clamp(g * 1.15, 0.0, 1.0));
        floorAlpha = max(floorAlpha, clamp(g * 0.88, 0.0, 0.90));
      }
    }
  }

  float b = dot(ro, rd);
  float c = dot(ro, ro) - 1.48 * 1.48;
  float disc = b * b - c;
  if (disc < 0.0) {
    fragColor = vec4(floorCol, floorAlpha);
    return;
  }
  float tStart = max(0.0, -b - sqrt(disc));
  float tEnd   = -b + sqrt(disc);

  float t = tStart;
  float hitMat = -1.0;
  float tHit = tEnd;
  float minPlushD = 9.9;
  float minPlushT = tStart;

  for (int i = 0; i < 56; i++) {
    vec3 p = ro + rd * t;
    vec2 h = mapScene(p, rig);
    if (h.y == 0.0 || h.y == 7.0) {
      if (h.x < minPlushD) {
        minPlushD = h.x;
        minPlushT = t;
      }
    }
    if (h.x < 0.0020) {
      hitMat = h.y;
      tHit = t;
      break;
    }
    t += max(h.x * 0.88, 0.0065);
    if (t > tEnd) break;
  }

  vec3 coreCol = vec3(0.0);
  float coreAlpha = 0.0;
  float grazeMask = 1.0;

  if (hitMat >= 0.0) {
    vec3 p = ro + rd * tHit;
    vec3 q = toLocal(p, rig);
    vec3 N = calcNormal(p, rig);
    vec3 V = -rd;
    float ao = calcAO(p, N, rig);
    int mId = int(hitMat + 0.5);

    if (mId == 0 || mId == 7) {
      bool isWing = (mId == 7);
      vec3 pCol = plushColorAt(q, isWing);

      grazeMask = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.6) * 0.75;

      FaceSample face;
      face.eyeMask = 0.0; face.eyeRingMask = 0.0; face.eyeGlint = 0.0;
      face.eyeRimAO = 0.0; face.blushMask = 0.0; face.eyeLocal = vec2(0.0);

      if (!isWing) {
        vec3 nLoc = N;
        nLoc.xz = rot2(-rig.yawAdd) * nLoc.xz;
        nLoc.yz = rot2(-rig.pitchAdd) * nLoc.yz;
        nLoc.xy = rot2(-rig.roll) * nLoc.xy;
        face = sampleFace(q, normalize(nLoc), rig);
      }

      grazeMask *= (1.0 - clamp(face.eyeMask + face.eyeRingMask, 0.0, 1.0));

      if (face.blushMask > 0.001) {
        vec3 blushCol = vec3(0.95, 0.56, 0.64);
        pCol = mix(pCol, blushCol, face.blushMask);
      }
      if (face.eyeRingMask > 0.001) {
        pCol = mix(pCol, vec3(0.97, 0.97, 0.95), face.eyeRingMask);
      }

      float eyeAO = ao * (1.0 - face.eyeRimAO * 0.42);
      coreCol = shadePlush(p, q, N, V, pCol, eyeAO, rig, isWing);

      if (face.eyeMask > 0.001) {
        vec3 eyeN = normalize(N + vec3(face.eyeLocal * 0.24, 0.15));
        vec3 L1 = normalize(vec3(-0.62, 0.82, 0.80));
        vec3 H1 = normalize(L1 + V);
        vec3 eyeBase = (uQuaker == 2)
          ? toLinear(vec3(0.76, 0.30, 0.34))
          : (uState == 9 ? toLinear(vec3(0.38, 0.40, 0.48)) : vec3(0.011, 0.009, 0.024));
        float eyeSpec = pow(max(dot(eyeN, H1), 0.0), (uQuaker > 0) ? 52.0 : 28.0);
        float eyeWrap = clamp((dot(eyeN, L1) + 0.45) / 1.45, 0.0, 1.0);
        vec3 eyeCol = eyeBase * (0.55 + 0.55 * eyeWrap) + vec3(0.45, 0.52, 0.72) * eyeSpec * ((uQuaker > 0) ? 0.32 : 0.06);
        eyeCol = mix(eyeCol, vec3(1.05, 1.05, 1.08), face.eyeGlint);
        coreCol = mix(coreCol, eyeCol, face.eyeMask);
      }
    } else {
      grazeMask = 0.0;
      coreCol = shadeSolidMat(mId, p, q, N, V, ao);
    }
    coreAlpha = 1.0;
  }

  float furLen = 0.084 * clamp(uFuzz, 0.0, 1.5);
  vec3 furAccum = vec3(0.0);
  float furAlpha = 0.0;

  if (furLen > 0.004 && minPlushD < furLen && grazeMask > 0.02) {
    vec3 pNear = ro + rd * minPlushT;
    vec3 gN = calcPlushGrad(pNear, rig);
    vec3 gNLoc = gN;
    gNLoc.xz = rot2(-rig.yawAdd) * gNLoc.xz;
    gNLoc.yz = rot2(-rig.pitchAdd) * gNLoc.yz;
    gNLoc.xy = rot2(-rig.roll) * gNLoc.xy;
    gNLoc = normalize(gNLoc);
    vec3 L1 = normalize(vec3(-0.62, 0.82, 0.80));
    vec3 L3 = normalize(vec3( 0.48, 0.70,-0.80));
    float jitter = hash12(gl_FragCoord.xy);

    float span = (hitMat >= 0.0) ? min(0.09, furLen * 1.25) : 0.26;
    float t0 = (hitMat >= 0.0) ? max(tStart, tHit - span) : max(tStart, minPlushT - span * 0.5);
    float t1 = (hitMat >= 0.0) ? tHit : min(tEnd, minPlushT + span * 0.5);
    float dt = (t1 - t0) / 8.0;

    for (int s = 0; s < 8; s++) {
      float ts = t0 + (float(s) + jitter) * dt;
      vec3 ps = ro + rd * ts;
      float dp = sdPlushOnly(ps, rig);
      if (dp > 0.0 && dp < furLen) {
        vec3 qs = toLocal(ps, rig);
        vec3 qSurf = qs - gNLoc * dp;
        float clump = smoothstep(0.18, 0.82, noise3(qSurf * 22.0));
        float strand = smoothstep(0.24, 0.84, noise3(qSurf * 82.0) * 0.65 + noise3(qSurf * 155.0) * 0.35);
        float tipLen = furLen * (0.22 + 0.78 * mix(strand, clump, 0.28));
        float h = dp / max(tipLen, 0.001);
        if (h < 1.0) {
          float dens = (1.0 - smoothstep(0.08, 1.0, h)) * (0.36 + 0.32 * clamp(uFuzz, 0.0, 1.5)) * grazeMask;
          vec3 bCol = toLinear(plushColorAt(qSurf, false));
          float d1 = clamp((dot(gN, L1) + 0.36) / 1.36, 0.0, 1.0);
          float backRim = pow(clamp(dot(gN, L3) * 0.5 + 0.5, 0.0, 1.0), 1.6);
          vec3 rootCol = pow(max(bCol, vec3(0.002)), vec3(1.35)) * 0.22;
          vec3 tipCol  = bCol * 1.15 + mix(bCol, vec3(1.0), 0.35) * (0.14 + backRim * 0.26);
          vec3 hairCol = mix(rootCol, tipCol, 0.22 + 0.78 * d1 * (0.55 + 0.45 * h));
          if (rig.floorGlow > 0.01) {
            hairCol += vec3(0.06, 0.72, 0.92) * clamp(-gN.y, 0.0, 1.0) * rig.floorGlow * 0.28;
          }
          float a = dens * (1.0 - furAlpha);
          furAccum += hairCol * a;
          furAlpha += a;
          if (furAlpha > 0.94) break;
        }
      }
    }
  }

  vec3 combinedPre = furAccum + coreCol * coreAlpha * (1.0 - furAlpha);
  float combinedA  = furAlpha + coreAlpha * (1.0 - furAlpha);

  if (uState == 9) {
    combinedPre *= 0.56;
    combinedA *= 0.56;
  }

  vec3 floorLin = toLinear(floorCol);
  vec3 outPre = combinedPre + floorLin * floorAlpha * (1.0 - combinedA);
  float outA  = combinedA + floorAlpha * (1.0 - combinedA);

  vec3 outRgb = (outA > 0.001) ? (outPre / outA) : vec3(0.0);
  outRgb = (outRgb * (2.51 * outRgb + 0.03)) / (outRgb * (2.43 * outRgb + 0.59) + 0.14);
  outRgb = pow(clamp(outRgb, 0.0, 1.0), vec3(1.0 / 2.2));

  fragColor = vec4(outRgb, clamp(outA, 0.0, 1.0));
}
`;

export interface Mongle3DSpec {
  readonly baseId: number;
  readonly shape: MongleShape;
  readonly tone: IdentityTone;
  readonly quaker: QuakerMorph | null;
  readonly role: MongleRole;
  readonly state: MongleState;
  readonly activity: MongleActivity | null;
  readonly size: number;
  readonly tempo: number;
  readonly mini: boolean;
  readonly hideBadge: boolean;
  readonly staticIdle: boolean;
}

interface Uniforms {
  readonly uTime: WebGLUniformLocation | null;
  readonly uTempo: WebGLUniformLocation | null;
  readonly uPhase: WebGLUniformLocation | null;
  readonly uFuzz: WebGLUniformLocation | null;
  readonly uYaw: WebGLUniformLocation | null;
  readonly uPitch: WebGLUniformLocation | null;
  readonly uShape: WebGLUniformLocation | null;
  readonly uQuaker: WebGLUniformLocation | null;
  readonly uState: WebGLUniformLocation | null;
  readonly uActivity: WebGLUniformLocation | null;
  readonly uPrevState: WebGLUniformLocation | null;
  readonly uPrevActivity: WebGLUniformLocation | null;
  readonly uTransBlend: WebGLUniformLocation | null;
  readonly uRole: WebGLUniformLocation | null;
  readonly uMini: WebGLUniformLocation | null;
  readonly uStatic: WebGLUniformLocation | null;
  readonly uLightBg: WebGLUniformLocation | null;
  readonly uBaseCol: WebGLUniformLocation | null;
}

interface MountedAvatar {
  readonly canvas: HTMLCanvasElement;
  spec: Mongle3DSpec;
  visible: boolean;
  lastRenderedAt: number;
  staticKey: string | null;
  prevState: MongleState;
  prevActivity: MongleActivity | null;
  transProgress: number;
  transStartedAt: number;
}

interface SharedEngine {
  glCanvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  uniforms: Uniforms;
}

let engine: SharedEngine | null = null;
let engineUnavailable = false;
let rafId: number | null = null;
let startTime = 0;
let fuzzSetting = DEFAULT_AVATAR_FUZZ;
let fuzzPreview: number | null = null;
let documentObserved = false;
let intersectionObserver: IntersectionObserver | null = null;
let osReducedMotion = false;
const mounted = new Map<HTMLCanvasElement, MountedAvatar>();

function clampFuzz(value: number): number {
  return Math.max(MIN_AVATAR_FUZZ, Math.min(MAX_AVATAR_FUZZ, value));
}

export function currentAvatarFuzz(): number {
  return fuzzPreview ?? fuzzSetting;
}

/** 서버 설정의 솜결 값을 반영한다. */
export function setAvatarFuzzSetting(value: number): void {
  const next = clampFuzz(value);
  if (fuzzSetting === next) return;
  fuzzSetting = next;
  invalidateAllStatic();
}

/** 설정 슬라이더 드래그 중 즉각 미리보기 — 저장 완료 또는 닫힐 때 null 로 해제한다. */
export function setAvatarFuzzPreview(value: number | null): void {
  const next = value === null ? null : clampFuzz(value);
  if (fuzzPreview === next) return;
  fuzzPreview = next;
  invalidateAllStatic();
}

function invalidateAllStatic(): void {
  for (const entry of mounted.values()) entry.staticKey = null;
  scheduleLoop();
}

function isLightTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
}

function isCalmMotion(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.avatarMotion === "calm";
}

function isSteppedMotion(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.stateMotion === "stepped";
}

function isMotionFrozenFor(spec: Mongle3DSpec): boolean {
  if (osReducedMotion) return true;
  if (spec.state === "fresh") return true;
  if (spec.staticIdle && spec.state === "idle") return true;
  if (isCalmMotion() && !CALLING_STATES.has(spec.state)) return true;
  return false;
}

function ensureDocumentObservers(): void {
  if (documentObserved || typeof window === "undefined" || typeof document === "undefined") return;
  documentObserved = true;

  if (typeof window.matchMedia === "function") {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    osReducedMotion = query.matches;
    query.addEventListener("change", (event) => {
      osReducedMotion = event.matches;
      invalidateAllStatic();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleLoop();
  });

  if (typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => {
      invalidateAllStatic();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-avatar-motion", "data-state-motion"],
    });
  }

  if (typeof IntersectionObserver !== "undefined") {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        let becameVisible = false;
        for (const item of entries) {
          const target = mounted.get(item.target as HTMLCanvasElement);
          if (!target) continue;
          const next = item.isIntersecting;
          if (next && !target.visible) becameVisible = true;
          target.visible = next;
        }
        if (becameVisible) scheduleLoop();
      },
      { rootMargin: "64px" },
    );
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function initEngine(): SharedEngine | null {
  if (engine) return engine;
  if (engineUnavailable || typeof document === "undefined") return null;

  const glCanvas = document.createElement("canvas");
  glCanvas.width = MAX_GL_SIZE;
  glCanvas.height = MAX_GL_SIZE;

  const gl = glCanvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: "low-power",
  });
  if (!gl) {
    engineUnavailable = true;
    return null;
  }

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    engineUnavailable = true;
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    engineUnavailable = true;
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    engineUnavailable = true;
    return null;
  }

  gl.useProgram(program);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);

  glCanvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    engine = null;
    stopLoop();
  });
  glCanvas.addEventListener("webglcontextrestored", () => {
    engine = null;
    invalidateAllStatic();
  });

  const uniforms: Uniforms = {
    uTime: gl.getUniformLocation(program, "uTime"),
    uTempo: gl.getUniformLocation(program, "uTempo"),
    uPhase: gl.getUniformLocation(program, "uPhase"),
    uFuzz: gl.getUniformLocation(program, "uFuzz"),
    uYaw: gl.getUniformLocation(program, "uYaw"),
    uPitch: gl.getUniformLocation(program, "uPitch"),
    uShape: gl.getUniformLocation(program, "uShape"),
    uQuaker: gl.getUniformLocation(program, "uQuaker"),
    uState: gl.getUniformLocation(program, "uState"),
    uActivity: gl.getUniformLocation(program, "uActivity"),
    uPrevState: gl.getUniformLocation(program, "uPrevState"),
    uPrevActivity: gl.getUniformLocation(program, "uPrevActivity"),
    uTransBlend: gl.getUniformLocation(program, "uTransBlend"),
    uRole: gl.getUniformLocation(program, "uRole"),
    uMini: gl.getUniformLocation(program, "uMini"),
    uStatic: gl.getUniformLocation(program, "uStatic"),
    uLightBg: gl.getUniformLocation(program, "uLightBg"),
    uBaseCol: gl.getUniformLocation(program, "uBaseCol"),
  };

  engine = { glCanvas, gl, uniforms };
  if (startTime === 0) startTime = typeof performance !== "undefined" ? performance.now() : Date.now();
  return engine;
}

function resolveCanvasResolution(size: number): number {
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2.5) : 1;
  const target = Math.ceil(Math.max(12, size) * dpr);
  if (size <= 24) return Math.min(Math.max(target, 56), 72);
  if (size <= 48) return Math.min(Math.max(target, 84), 128);
  return Math.min(Math.max(target, 144), MAX_GL_SIZE);
}

function drawEntry(activeEngine: SharedEngine, entry: MountedAvatar, elapsedSec: number, lightBg: boolean, fuzz: number): void {
  const { gl, glCanvas, uniforms } = activeEngine;
  const { canvas, spec } = entry;
  const res = resolveCanvasResolution(spec.size);

  if (canvas.width !== res || canvas.height !== res) {
    canvas.width = res;
    canvas.height = res;
  }

  const vpY = MAX_GL_SIZE - res;
  gl.viewport(0, vpY, res, res);
  gl.scissor(0, vpY, res, res);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const color: Rgb = spec.quaker
    ? QUAKER_PASTEL_TONES[spec.quaker]
    : spec.role === "commodore"
      ? PLUSH_VIVID_TONES[spec.tone]
      : FLEET_PASTEL_TONES[spec.tone];
  const frozen = isMotionFrozenFor(spec);
  const effectiveRole = spec.hideBadge && spec.role === "commodore" ? 2 : ROLE_CODE[spec.role];

  gl.uniform1f(uniforms.uTime, elapsedSec);
  gl.uniform1f(uniforms.uTempo, spec.tempo);
  gl.uniform1f(uniforms.uPhase, spec.baseId * 1.73);
  gl.uniform1f(uniforms.uFuzz, fuzz);
  gl.uniform1f(uniforms.uYaw, -0.24);
  gl.uniform1f(uniforms.uPitch, 0.06);
  gl.uniform1i(uniforms.uShape, spec.quaker ? 10 : SHAPE_CODE[spec.shape]);
  gl.uniform1i(uniforms.uQuaker, spec.quaker ? QUAKER_CODE[spec.quaker] : 0);
  gl.uniform1i(uniforms.uState, STATE_CODE[spec.state]);
  gl.uniform1i(uniforms.uActivity, spec.activity ? ACTIVITY_CODE[spec.activity] : 0);
  gl.uniform1i(uniforms.uPrevState, STATE_CODE[entry.prevState]);
  gl.uniform1i(uniforms.uPrevActivity, entry.prevActivity ? ACTIVITY_CODE[entry.prevActivity] : 0);
  gl.uniform1f(uniforms.uTransBlend, frozen ? 1.0 : entry.transProgress);
  gl.uniform1i(uniforms.uRole, effectiveRole);
  gl.uniform1i(uniforms.uMini, spec.mini ? 1 : 0);
  gl.uniform1i(uniforms.uStatic, frozen ? 1 : 0);
  gl.uniform1i(uniforms.uLightBg, lightBg ? 1 : 0);
  gl.uniform3f(uniforms.uBaseCol, color[0], color[1], color[2]);

  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, res, res);
  ctx.drawImage(glCanvas, 0, 0, res, res, 0, 0, res, res);
}

function staticSignature(spec: Mongle3DSpec, lightBg: boolean, fuzz: number): string {
  return `${spec.baseId}:${spec.shape}:${spec.tone}:${spec.quaker ?? ""}:${spec.role}:${spec.state}:${spec.activity ?? ""}:${spec.size}:${spec.mini ? 1 : 0}:${spec.hideBadge ? 1 : 0}:${lightBg ? 1 : 0}:${fuzz.toFixed(2)}`;
}

function stopLoop(): void {
  if (rafId !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(rafId);
  }
  rafId = null;
}

function tick(now: number): void {
  rafId = null;
  if (typeof document !== "undefined" && document.hidden) return;
  if (mounted.size === 0) return;

  const activeEngine = initEngine();
  if (!activeEngine) return;

  const elapsedSec = (now - startTime) * 0.001;
  const lightBg = isLightTheme();
  const fuzz = currentAvatarFuzz();
  const stepped = isSteppedMotion();

  let needsNextFrame = false;

  for (const entry of mounted.values()) {
    if (!entry.visible) continue;
    const frozen = isMotionFrozenFor(entry.spec);
    if (frozen) {
      entry.prevState = entry.spec.state;
      entry.prevActivity = entry.spec.activity;
      entry.transProgress = 1;
      const key = staticSignature(entry.spec, lightBg, fuzz);
      if (entry.staticKey !== key) {
        drawEntry(activeEngine, entry, 0, lightBg, fuzz);
        entry.staticKey = key;
        entry.lastRenderedAt = now;
      }
      continue;
    }

    if (entry.transProgress < 1) {
      const nextProgress = Math.min(1, Math.max(0, (now - entry.transStartedAt) / POSE_TRANSITION_MS));
      entry.transProgress = nextProgress;
      if (nextProgress >= 1) {
        entry.prevState = entry.spec.state;
        entry.prevActivity = entry.spec.activity;
      }
    }

    needsNextFrame = true;
    const transitioning = entry.transProgress < 1;
    const interval = stepped
      ? STEPPED_FRAME_INTERVAL_MS
      : (!transitioning && entry.spec.state === "idle" && entry.spec.size < 36 ? SMALL_IDLE_FRAME_INTERVAL_MS : 0);

    if (interval > 0 && now - entry.lastRenderedAt < interval) continue;
    drawEntry(activeEngine, entry, elapsedSec, lightBg, fuzz);
    entry.lastRenderedAt = now;
    entry.staticKey = null;
  }

  if (needsNextFrame && typeof requestAnimationFrame === "function") {
    rafId = requestAnimationFrame(tick);
  }
}

function scheduleLoop(): void {
  if (typeof document !== "undefined" && document.hidden) return;
  if (mounted.size === 0 || rafId !== null) return;
  if (typeof requestAnimationFrame === "function") {
    rafId = requestAnimationFrame(tick);
  }
}

/** 캔버스를 공용 3D 플러시 렌더러에 등록하거나 사양을 갱신한다. */
export function mountMongle3DCanvas(canvas: HTMLCanvasElement, spec: Mongle3DSpec): () => void {
  ensureDocumentObservers();
  const entry: MountedAvatar = {
    canvas,
    spec,
    visible: true,
    lastRenderedAt: 0,
    staticKey: null,
    prevState: spec.state,
    prevActivity: spec.activity,
    transProgress: 1,
    transStartedAt: 0,
  };
  mounted.set(canvas, entry);
  intersectionObserver?.observe(canvas);
  scheduleLoop();
  return () => {
    intersectionObserver?.unobserve(canvas);
    mounted.delete(canvas);
    if (mounted.size === 0) stopLoop();
  };
}

export function updateMongle3DCanvas(canvas: HTMLCanvasElement, spec: Mongle3DSpec): void {
  const entry = mounted.get(canvas);
  if (!entry) return;
  const poseChanged = entry.spec.state !== spec.state || entry.spec.activity !== spec.activity;
  if (poseChanged) {
    if (isMotionFrozenFor(spec)) {
      entry.prevState = spec.state;
      entry.prevActivity = spec.activity;
      entry.transProgress = 1;
    } else {
      entry.prevState = entry.spec.state;
      entry.prevActivity = entry.spec.activity;
      entry.transProgress = 0;
      entry.transStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    }
  }
  entry.spec = spec;
  entry.staticKey = null;
  scheduleLoop();
}
