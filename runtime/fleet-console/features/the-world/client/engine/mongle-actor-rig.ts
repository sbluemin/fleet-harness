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
import type { WorldAdmiralCape, WorldAdmiralHat } from "../../shared/world-types.js";

/**
 * `mongle-3d-glsl.ts` (현행 2D 사이드바 아바타와 동일 SSOT) 기반 360° 3D 월드 볼류메트릭 캐릭터 메쉬.
 *
 * - 제독모(Admiral Cap) 상단 솜결 번짐 방지 마스킹 및 낮 시간대 알베도 클램핑 적용
 * - 발밑 3D 타깃 링(선택 시 황동빛 링 · `[E]` 근접 시 하늘빛 링) 및 다이아몬드 승인 비콘 포함
 */

const ACTOR_VERTEX = /* glsl */ `
uniform vec3 uCharCenter;
uniform float uCharScale;
uniform float uBoundRad;
out vec3 vWorldPos;

void main() {
  vec3 wp = uCharCenter + position * (uBoundRad * uCharScale);
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
uniform float uBoundRad;
uniform float uCharYaw;
uniform float uTime;
uniform float uPhase;
uniform float uFuzz;
uniform int uShape;
uniform int uQuaker;
uniform float uStarlight;
uniform int uState;
uniform int uActivity;
uniform int uPrevState;
uniform int uPrevActivity;
uniform int uRole;
uniform int uHat;
uniform int uGiftHat;
uniform int uCape;
uniform int uWorldAnim;
uniform int uPrevWorldAnim;
uniform float uAnimBlend;
uniform int uExpression;
uniform float uAnimPhase;
uniform float uMoveSpeed;
uniform float uJumpVel;
uniform float uLandSquash;
uniform float uLookYaw;
uniform float uLookPitch;
uniform float uBlush;
uniform float uHatBounce;
uniform float uFlightRoll;
uniform float uFlightPitch;
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
  float wingFlapL;
  float wingFlapR;
  float hatBounce;
  float supermanPose;
  float fightPose;
  float legStride;
  float auraBoost;
  float blushAdd;
  int exprMode;
};

float sdHappyEyeArc(vec2 p) {
  vec2 q = vec2(abs(p.x), p.y);
  float xC = clamp(q.x, 0.0, 0.084);
  float yC = 0.040 - (xC * xC) * 6.8;
  return length(q - vec2(xC, yC)) - 0.022;
}

float sdSleepyEyeLine(vec2 p) {
  vec2 q = vec2(abs(p.x), p.y);
  float xC = clamp(q.x, 0.0, 0.084);
  float yC = -0.015 + (xC * xC) * 2.8;
  return length(q - vec2(xC, yC)) - 0.017;
}

AnimRig mixAnimRig(AnimRig a, AnimRig b, float k) {
  AnimRig r;
  r.offset = mix(a.offset, b.offset, k);
  r.scale = mix(a.scale, b.scale, k);
  r.roll = mix(a.roll, b.roll, k);
  r.yawAdd = mix(a.yawAdd, b.yawAdd, k);
  r.pitchAdd = mix(a.pitchAdd, b.pitchAdd, k);
  r.eyeShift = mix(a.eyeShift, b.eyeShift, k);
  r.eyeBlink = mix(a.eyeBlink, b.eyeBlink, k);
  r.wingFlapL = mix(a.wingFlapL, b.wingFlapL, k);
  r.wingFlapR = mix(a.wingFlapR, b.wingFlapR, k);
  r.hatBounce = mix(a.hatBounce, b.hatBounce, k);
  r.supermanPose = mix(a.supermanPose, b.supermanPose, k);
  r.fightPose = mix(a.fightPose, b.fightPose, k);
  r.legStride = mix(a.legStride, b.legStride, k);
  r.auraBoost = mix(a.auraBoost, b.auraBoost, k);
  r.blushAdd = mix(a.blushAdd, b.blushAdd, k);
  r.exprMode = (k < 0.5) ? a.exprMode : b.exprMode;
  return r;
}

AnimRig computeAnimRigFor(int worldAnim, int state, int activity, float t) {
  AnimRig r;
  r.offset = vec3(0.0);
  r.scale = vec3(1.0);
  r.roll = 0.0;
  r.yawAdd = 0.0;
  r.pitchAdd = 0.0;
  r.eyeShift = vec2(0.0);
  r.eyeBlink = 1.0;
  r.wingFlapL = 0.0;
  r.wingFlapR = 0.0;
  r.hatBounce = clamp(uHatBounce, -0.18, 0.18);
  r.supermanPose = 0.0;
  r.fightPose = 0.0;
  r.legStride = 0.0;
  r.auraBoost = 0.0;
  r.blushAdd = 0.0;
  r.exprMode = uExpression;

  if (uQuaker > 0 || uStarlight > 0.5) {
    float wAmp = (state == 1 || state == 2) ? 0.30 : 0.14;
    float wSpd = (state == 1 || state == 2) ? 7.0 : 3.2;
    float wf = sin(t * wSpd) * wAmp;
    r.wingFlapL = wf;
    r.wingFlapR = wf;
  }

  float bt = fract(t / 4.4);
  if (bt > 0.92 && bt < 0.98) {
    r.eyeBlink = mix(1.0, 0.12, sin((bt - 0.92) / 0.06 * 3.14159));
  }

  if (worldAnim == 0) {
    // 기본 대기/상태 모션 (하위 호환)
    if (state == 0) {
      float breath = sin(t * 2.2);
      r.scale = vec3(1.0 + breath * 0.025, 1.0 - breath * 0.026, 1.0 + breath * 0.018);
      r.roll = sin(t * 1.2) * 0.04;
    } else if (state == 1) {
      r.roll = sin(t * 1.8) * 0.06;
      if (activity == 1) {
        float w = sin(t * 2.2);
        r.roll = -0.12 + w * 0.05;
        r.eyeShift = vec2(sin(t * 1.5) * 0.04, 0.04);
      } else if (activity == 2) {
        r.pitchAdd = 0.07;
        r.eyeShift = vec2(sin(t * 2.6) * 0.05, -0.04);
      } else if (activity == 3) {
        float w = sin(t * 7.8);
        r.scale = vec3(1.0 + w * 0.06, 1.0 - w * 0.07, 1.0 + w * 0.03);
        r.eyeShift = vec2(-0.02, -0.035);
      } else if (activity == 4) {
        float p = fract(t * 0.9);
        float sq = sin(p * 6.28318);
        r.scale = vec3(1.0 - sq * 0.08, 1.0 + sq * 0.09, 1.0 - sq * 0.05);
      } else if (activity == 5) {
        float sc = sin(t * 2.6);
        r.yawAdd = sc * 0.18;
        r.eyeShift = vec2(sc * 0.05, 0.025);
      } else if (activity == 6) {
        float w = sin(t * 4.2);
        r.scale = vec3(1.0 - w * 0.04, 1.0 + w * 0.05, 1.0);
      }
    } else if (state == 2 || state == 3) {
      float sw = sin(t * 2.4);
      r.roll = sw * 0.16;
      r.eyeShift = vec2(0.0, 0.035);
    }
  } else if (worldAnim == 1) {
    // walk: 동물의숲/펭귄식 좌우 뒤뚱 + 통통 발걸음 바운스
    float spd = clamp(uMoveSpeed / 3.4, 0.40, 1.50);
    float g = t * (7.2 + spd * 3.6);
    float stepBounce = abs(sin(g));
    float st = (stepBounce - 0.5) * 0.075 * spd;
    r.roll = sin(g) * (0.11 + 0.05 * spd);
    r.pitchAdd = 0.055 * spd;
    r.offset.y += stepBounce * 0.068 * spd;
    r.scale = vec3(1.0 - st * 0.65, 1.0 + st, 1.0 - st * 0.65);
    r.wingFlapL = sin(g) * 0.34;
    r.wingFlapR = -sin(g) * 0.34;
  } else if (worldAnim == 2) {
    // sprint: 상체 전방 기울임(+0.26 rad) + 하단 별 발 경쾌한 교차 발구름 + 망토 펼침
    float g = t * 15.2;
    float sb = abs(sin(g));
    float st = (sb - 0.45) * 0.13;
    r.pitchAdd = 0.26;
    r.roll = sin(g) * 0.13;
    r.offset.y += sb * 0.095;
    r.scale = vec3(1.0 - st * 0.70, 1.0 + st, 1.0 + 0.05 - st * 0.45);
    r.wingFlapL = 0.18 + sin(g * 1.15) * 0.42;
    r.wingFlapR = -0.18 - sin(g * 1.15) * 0.42;
    r.legStride = sin(g);
  } else if (worldAnim == 3) {
    // jump: 상승 세로 스트레치 + 공중 날개 펼침
    float jv = clamp(uJumpVel * 0.13, -0.22, 0.24);
    float stretch = abs(jv);
    r.scale = vec3(1.0 - stretch * 0.42, 1.0 + stretch * 0.64, 1.0 - stretch * 0.42);
    r.pitchAdd = -jv * 0.42;
    r.wingFlapL = 0.44 + sin(t * 14.0) * 0.16;
    r.wingFlapR = r.wingFlapL;
  } else if (worldAnim == 4) {
    // sit: 푹신한 착석 스쿼시 + 은은한 불멍 살랑임
    float br = sin(t * 1.8);
    r.offset.y = -0.10;
    r.scale = vec3(1.10 + br * 0.022, 0.87 - br * 0.020, 1.10 + br * 0.018);
    r.roll = sin(t * 1.3) * 0.055;
    r.pitchAdd = -0.04;
    r.wingFlapL = -0.10;
    r.wingFlapR = -0.10;
  } else if (worldAnim == 5) {
    // doze: 서서히 고개가 숙여졌다 깜짝 놀라며 드는 졸음 루프
    float cyc = fract(t / 3.6);
    float br = sin(t * 1.5);
    r.offset.y = -0.09;
    r.scale = vec3(1.08 + br * 0.025, 0.88 - br * 0.022, 1.08);
    if (cyc < 0.78) {
      float droop = smoothstep(0.05, 0.76, cyc);
      r.pitchAdd = droop * 0.30;
      r.roll = sin(t * 1.1) * 0.06 + droop * 0.08;
      if (droop > 0.28) r.exprMode = 2;
    } else if (cyc < 0.90) {
      float jolt = sin(((cyc - 0.78) / 0.12) * 3.14159);
      r.pitchAdd = mix(0.28, -0.09, jolt);
      r.offset.y += jolt * 0.06;
      r.scale *= vec3(1.0 - jolt * 0.06, 1.0 + jolt * 0.08, 1.0 - jolt * 0.06);
      r.exprMode = 3;
    } else {
      float settle = (cyc - 0.90) / 0.10;
      r.pitchAdd = mix(-0.06, 0.02, settle);
    }
  } else if (worldAnim == 6) {
    // sleep: 깊은 호흡 + 옆으로 기댄 평온한 잠
    float br = sin(t * 1.25);
    r.offset.y = -0.12;
    r.roll = 0.23 + br * 0.025;
    r.pitchAdd = 0.10;
    r.scale = vec3(1.11 + br * 0.045, 0.84 - br * 0.038, 1.09 + br * 0.032);
    r.wingFlapL = -0.14;
    r.wingFlapR = -0.14;
    r.exprMode = 2;
  } else if (worldAnim == 7) {
    // talk: 길 위 수다 리듬 끄덕임 + 고개 갸웃
    float nod = sin(t * 6.8);
    r.pitchAdd = nod * 0.10;
    r.roll = sin(t * 3.1) * 0.13;
    r.yawAdd = sin(t * 2.4) * 0.10;
    r.offset.y += max(0.0, nod) * 0.038;
    r.scale = vec3(1.0 - nod * 0.03, 1.0 + nod * 0.04, 1.0 - nod * 0.03);
    r.wingFlapL = sin(t * 6.8) * 0.26;
    r.wingFlapR = -sin(t * 6.8 + 0.6) * 0.26;
  } else if (worldAnim == 8) {
    // wave: 고개 갸웃 + 오른 날개/손 신나게 인사 흔들기
    float ph = uAnimPhase;
    float wv = sin(ph * 11.5);
    float sq = sin(ph * 5.8) * 0.05;
    r.roll = -0.14 + wv * 0.10;
    r.yawAdd = 0.08 + sin(ph * 5.5) * 0.07;
    r.offset.y += abs(sin(ph * 5.8)) * 0.055;
    r.scale = vec3(1.0 - sq, 1.0 + sq, 1.0 - sq);
    r.wingFlapR = 0.54 + wv * 0.34;
    r.wingFlapL = -0.06 + sin(ph * 4.0) * 0.06;
  } else if (worldAnim == 9) {
    // cheer: 예비 웅크림 → 신나는 2단 화이팅 점프 + 양 팔/날개 번쩍
    float ph = uAnimPhase;
    if (ph < 0.18) {
      float dip = sin((ph / 0.18) * 3.1415926);
      r.offset.y -= dip * 0.09;
      r.scale = vec3(1.0 + dip * 0.14, 1.0 - dip * 0.16, 1.0 + dip * 0.14);
      r.fightPose = -0.22 * dip;
    } else {
      float hp = ph - 0.18;
      float hop = abs(sin(hp * 7.6));
      float st = (hop - 0.32) * 0.16;
      r.offset.y += hop * 0.19;
      r.scale = vec3(1.0 - st * 0.62, 1.0 + st, 1.0 - st * 0.62);
      r.roll = sin(hp * 7.6) * 0.14;
      r.wingFlapL = 0.50 + sin(hp * 16.0) * 0.34;
      r.wingFlapR = r.wingFlapL;
      r.fightPose = 0.68 + hop * 0.32;
      r.blushAdd = 0.55;
      r.exprMode = 1;
    }
  } else if (worldAnim == 10) {
    // spin: 360도 공중 회전 + 탄성 스트레치
    float u = clamp(uAnimPhase / 0.85, 0.0, 1.0);
    float easeU = u * u * (3.0 - 2.0 * u);
    float arc = sin(u * 3.1415926);
    r.yawAdd = easeU * 6.2831853;
    r.offset.y += arc * 0.18;
    r.scale = vec3(1.0 - arc * 0.12, 1.0 + arc * 0.18, 1.0 - arc * 0.12);
    r.wingFlapL = arc * 0.56;
    r.wingFlapR = arc * 0.56;
  } else if (worldAnim == 11) {
    // shake: 빗물 털어내기 고속 부르르 진동
    float ph = uAnimPhase;
    float env = sin(clamp(ph / 0.85, 0.0, 1.0) * 3.1415926);
    float sh = sin(ph * 36.0) * env;
    r.roll = sh * 0.24;
    r.yawAdd = cos(ph * 36.0) * env * 0.20;
    r.scale = vec3(1.0 + abs(sh) * 0.08, 1.0 - abs(sh) * 0.07, 1.0 + abs(sh) * 0.06);
    r.wingFlapL = sh * 0.44;
    r.wingFlapR = -sh * 0.44;
    r.exprMode = 2;
  } else if (worldAnim == 12) {
    // work-edit: 리드미컬한 망치/코딩 끄덕임
    float w = sin(t * 8.4);
    float hit = pow(max(0.0, w), 2.0);
    r.pitchAdd = 0.06 + hit * 0.16;
    r.scale = vec3(1.0 + hit * 0.08, 1.0 - hit * 0.09, 1.0 + hit * 0.05);
    r.eyeShift = vec2(-0.02, -0.04);
    r.wingFlapR = 0.18 + hit * 0.38;
  } else if (worldAnim == 13) {
    // work-read: 좌우 훑기 + 아래 시선
    float sc = sin(t * 2.8);
    r.pitchAdd = 0.12;
    r.yawAdd = sc * 0.12;
    r.eyeShift = vec2(sc * 0.065, -0.055);
  } else if (worldAnim == 14) {
    // work-think: 고개 갸웃 사색
    float w = sin(t * 2.1);
    r.roll = -0.15 + w * 0.06;
    r.pitchAdd = -0.05;
    r.eyeShift = vec2(sin(t * 1.4) * 0.05, 0.055);
  } else if (worldAnim == 15) {
    // work-run: 신속 집중 펄스
    float p = sin(t * 6.4);
    r.scale = vec3(1.0 - p * 0.07, 1.0 + p * 0.08, 1.0 - p * 0.05);
    r.offset.y += max(0.0, p) * 0.045;
    r.wingFlapL = p * 0.25;
    r.wingFlapR = p * 0.25;
  } else if (worldAnim == 16) {
    // fly: 정지 호버(똑바로 선 귀여운 별) ↔ 이동/부스트 슈퍼맨 비행 자세 부드러운 전환
    float superman = smoothstep(0.8, 5.5, uMoveSpeed);
    float boost = smoothstep(20.0, 32.0, uMoveSpeed);
    float hover = sin(t * 3.3);
    r.offset.y += hover * mix(0.095, 0.035, superman);
    r.pitchAdd = mix(0.0, 1.15 + boost * 0.13, superman);
    r.roll = sin(t * 2.1) * mix(0.055, 0.025, superman);
    r.scale = mix(
      vec3(1.0 + hover * 0.015, 1.0 - hover * 0.015, 1.0 + hover * 0.012),
      vec3(0.95, 1.08 + boost * 0.06, 0.96),
      superman
    );
    r.wingFlapL = mix(0.16 + sin(t * 4.4) * 0.12, 0.06, superman);
    r.wingFlapR = mix(0.16 + sin(t * 4.4) * 0.12, 0.06, superman);
    r.supermanPose = superman;
    r.auraBoost = 0.42 + superman * 0.24 + boost * 0.24;
    if (boost > 0.35 && r.exprMode == 0) r.exprMode = 1;
  } else if (worldAnim == 17) {
    // dive: 별똥별 유성 급강하 — 빠른 360° 코멧 회전 + 강렬한 황금 오라
    float ph = (uAnimPhase > 0.001) ? uAnimPhase : t;
    r.yawAdd = ph * 12.6;
    r.pitchAdd = 0.88;
    r.roll = sin(ph * 9.0) * 0.10;
    r.scale = vec3(0.88, 1.18, 0.90);
    r.wingFlapL = 0.58;
    r.wingFlapR = 0.58;
    r.supermanPose = 0.55;
    r.auraBoost = 1.0;
    r.exprMode = 1;
  } else if (worldAnim == 20) {
    // takeoff-charge: 1단계 제자리 줌인 화이팅 자세 (0..0.34 예비 웅크림 → 0.34..1.0 힘찬 만세/화이팅!)
    float ph = clamp(uAnimPhase, 0.0, 1.0);
    if (ph < 0.34) {
      float u = smoothstep(0.0, 0.34, ph);
      r.offset.y -= u * 0.11;
      r.scale = mix(vec3(1.0), vec3(1.16, 0.82, 1.16), u);
      r.pitchAdd = 0.14 * u;
      r.fightPose = -0.28 * u;
      r.auraBoost = u * 0.25;
      r.exprMode = 4;
    } else {
      float u = smoothstep(0.34, 0.62, ph);
      float hold = smoothstep(0.34, 1.0, ph);
      float pulse = sin(ph * 26.0) * 0.022 * u;
      r.offset.y += mix(-0.11, 0.11, u) + pulse;
      r.scale = mix(vec3(1.16, 0.82, 1.16), vec3(0.95, 1.15, 0.95), u);
      r.pitchAdd = mix(0.14, -0.06, u);
      r.roll = sin(ph * 18.0) * 0.045 * u;
      r.hatBounce += sin(u * 3.1415926) * 0.07;
      r.wingFlapL = 0.65 * u;
      r.wingFlapR = 0.65 * u;
      r.fightPose = u;
      r.auraBoost = mix(0.28, 0.86, hold);
      r.blushAdd = 0.82 * u;
      r.exprMode = 1;
    }
  } else if (worldAnim == 21) {
    // takeoff-ascend: 2단계 빙글빙글 회오리 수직 상승 (360°×2.5 회전 + 세로 스트레치 + 강렬한 별빛 오라)
    float ph = (uAnimPhase > 0.001) ? clamp(uAnimPhase, 0.0, 1.0) : fract(t * 1.4);
    float ease = smoothstep(0.0, 0.18, ph);
    r.yawAdd = ph * 15.707963;
    r.pitchAdd = -0.06 * ease;
    r.scale = mix(vec3(0.96, 1.12, 0.96), vec3(0.86, 1.24, 0.86), ease);
    r.wingFlapL = 0.72;
    r.wingFlapR = 0.72;
    r.fightPose = 0.88;
    r.auraBoost = 1.0;
    r.blushAdd = 0.65;
    r.exprMode = 1;
  } else if (worldAnim == 22) {
    // hero-land: 유성 착지 히어로 폼(0..0.44 탄성 스쿼시) → 화이팅 피니시(0.44..1.0 뿌듯한 착지 포즈)
    float ph = clamp(uAnimPhase, 0.0, 1.0);
    if (ph < 0.44) {
      float u = sin((ph / 0.44) * 3.1415926);
      r.offset.y -= u * 0.16;
      r.scale = mix(vec3(1.0), vec3(1.22, 0.72, 1.22), u);
      r.pitchAdd = 0.22 * u;
      r.fightPose = -0.24 * u;
      r.auraBoost = (1.0 - ph / 0.44) * 0.65;
      r.exprMode = 4;
    } else {
      float u = smoothstep(0.44, 0.72, ph);
      float tail = 1.0 - smoothstep(0.85, 1.0, ph);
      float pop = sin(u * 3.1415926);
      r.offset.y += pop * 0.15 * tail;
      r.scale = mix(vec3(1.0), vec3(0.94, 1.13, 0.94), pop * 0.75 * tail);
      r.pitchAdd = -0.05 * u * tail;
      r.hatBounce += pop * 0.06 * tail;
      r.wingFlapL = 0.62 * u * tail;
      r.wingFlapR = 0.62 * u * tail;
      r.fightPose = u * tail;
      r.auraBoost = 0.32 * tail;
      r.blushAdd = 0.72 * tail;
      r.exprMode = 1;
    }
  }

  return r;
}

AnimRig computeAnim() {
  float t = uTime + uPhase;
  AnimRig r = computeAnimRigFor(uWorldAnim, uState, uActivity, t);
  if (
    uAnimBlend < 0.999
    && (uPrevWorldAnim != uWorldAnim || uPrevState != uState || uPrevActivity != uActivity)
  ) {
    AnimRig prevRig = computeAnimRigFor(uPrevWorldAnim, uPrevState, uPrevActivity, t);
    r = mixAnimRig(prevRig, r, smoothstep(0.0, 1.0, clamp(uAnimBlend, 0.0, 1.0)));
  }

  // 비행 뱅킹/배럴롤(±2π 전체 지원) · 피치 기울기 (player-controller 물리 연동)
  r.roll += uFlightRoll;
  if (uWorldAnim == 16) {
    r.pitchAdd = clamp(r.pitchAdd + uFlightPitch * 0.18, -0.45, 1.32);
  } else if (uWorldAnim == 17) {
    r.pitchAdd = clamp(r.pitchAdd + uFlightPitch * 0.22, -0.45, 1.32);
  } else if (uWorldAnim != 20 && uWorldAnim != 21 && uWorldAnim != 22) {
    r.pitchAdd += clamp(uFlightPitch, -0.75, 0.85);
  }

  // 착지 스쿼시-앤-스트레치 (히어로 착지 자체 스쿼시와 이중 중첩 방지)
  float ls = (uWorldAnim == 22) ? 0.0 : clamp(uLandSquash, 0.0, 1.0);
  if (ls > 0.001) {
    r.scale *= vec3(1.0 + ls * 0.18, 1.0 - ls * 0.22, 1.0 + ls * 0.18);
    r.offset.y -= ls * 0.09;
  }
  if (uWorldAnim != 3 && uWorldAnim != 16 && uWorldAnim != 17 && uWorldAnim != 21 && abs(uJumpVel) > 0.05) {
    float jv = clamp(uJumpVel * 0.09, -0.16, 0.18);
    r.scale *= vec3(1.0 - abs(jv) * 0.34, 1.0 + abs(jv) * 0.48, 1.0 - abs(jv) * 0.34);
  }

  // 부드러운 시선 추적 (눈동자 + 은은한 고개 회선 — 회오리·화이팅·스핀 중엔 고정 유지)
  float ly = clamp(uLookYaw, -1.0, 1.0);
  float lp = clamp(uLookPitch, -1.0, 1.0);
  r.eyeShift += vec2(ly * 0.058, lp * 0.048);
  if (uWorldAnim != 10 && uWorldAnim != 11 && uWorldAnim != 17 && uWorldAnim != 20 && uWorldAnim != 21 && uWorldAnim != 22) {
    r.yawAdd += ly * 0.14;
    r.pitchAdd -= lp * 0.09;
  }

  return r;
}

vec3 toLocal(vec3 p, AnimRig rig) {
  vec3 q = p - rig.offset;
  q.xz = rot2(-rig.yawAdd) * q.xz;
  // roll을 pitch 이전에 적용해 수평 슈퍼맨 비행 중 360° 에일러론 배럴롤이 진행 축(+Z) 기준으로 회전하도록 정렬
  q.xy = rot2(-rig.roll) * q.xy;
  q.yz = rot2(rig.pitchAdd) * q.yz;
  q /= rig.scale;
  return q;
}

float sdMarioStar(vec3 q, AnimRig rig) {
  // 각진 능선 없이 말랑·몽글몽글한 마시멜로 쿠션 5각 별 (호버 · 슈퍼맨 비행 · 화이팅 포즈 · 질주 발구름 부드러운 블렌딩)
  vec3 sp = q - vec3(0.0, 0.01, 0.0);
  float core = sdEllipsoid(sp, vec3(0.45, 0.43, 0.38));

  // 1) 위쪽 꼭짓점 (모자 없음일 땐 통통하게 톡, 모자 착용 시 모자 안쪽으로 부드럽게 안착)
  float topY = (uHat == 3) ? 0.56 : 0.39;
  float topPt = sdRoundCone(sp, vec3(0.0, 0.08, 0.0), vec3(0.0, topY, 0.0), 0.255, 0.155);

  // 2~3) 좌우 별 팔 꼭짓점: 기본 5각 별 ↔ 화이팅 만세 ↔ 슈퍼맨 비행 포즈
  float sm = clamp(rig.supermanPose, 0.0, 1.0);
  float fp = clamp(rig.fightPose, -0.35, 1.0);

  vec3 armLStart = mix(vec3(-0.14, 0.03, 0.0), vec3(-0.14, 0.02, -0.02), sm);
  vec3 armLBase = vec3(-0.56, 0.17, 0.0);
  vec2 alOff = armLBase.xy - armLStart.xy;
  alOff = rot2(rig.wingFlapL * 0.26) * alOff;
  vec3 armLTip = vec3(armLStart.xy + alOff, 0.0);
  if (fp > 0.001) {
    // 양 별 팔을 바깥쪽 V자로 경쾌하게 번쩍 들어 모자와 실루엣이 겹치지 않는 5각 별 화이팅 자세 유지
    armLTip = mix(armLTip, vec3(-0.48, 0.45, 0.12), fp);
  } else if (fp < -0.001) {
    armLTip = mix(armLTip, vec3(-0.52, -0.02, 0.06), -fp);
  }
  armLTip = mix(armLTip, vec3(-0.38, -0.08, -0.05), sm);
  float armL = sdRoundCone(sp, armLStart, armLTip, 0.245, 0.152);

  vec3 armRStart = mix(vec3(0.14, 0.03, 0.0), vec3(0.12, 0.14, 0.03), sm);
  vec3 armRBase = vec3(0.56, 0.17, 0.0);
  vec2 arOff = armRBase.xy - armRStart.xy;
  arOff = rot2(-rig.wingFlapR * 0.26) * arOff;
  vec3 armRTip = vec3(armRStart.xy + arOff, 0.0);
  if (fp > 0.001) {
    armRTip = mix(armRTip, vec3(0.48, 0.45, 0.12), fp);
  } else if (fp < -0.001) {
    armRTip = mix(armRTip, vec3(0.52, -0.02, 0.06), -fp);
  }
  // 슈퍼맨 시그니처: 오른 별 팔을 앞으로 쭉 뻗어 히어로 비행 실루엣 완성!
  armRTip = mix(armRTip, vec3(0.22, 0.66, 0.06), sm);
  float armR = sdRoundCone(sp, armRStart, armRTip, 0.245, 0.152);

  // 4~5) 하단 좌우 별 다리: 기본 5각 대칭 ↔ 질주 교차 발구름 ↔ 슈퍼맨 뒤로 쭉 뻗은 다리
  vec3 legLTip = vec3(-0.35, -0.47, 0.0);
  vec3 legRTip = vec3( 0.35, -0.47, 0.0);
  if (abs(rig.legStride) > 0.001) {
    legLTip += vec3(0.0, max(0.0, rig.legStride) * 0.08, rig.legStride * 0.16);
    legRTip += vec3(0.0, max(0.0, -rig.legStride) * 0.08, -rig.legStride * 0.16);
  }
  legLTip = mix(legLTip, vec3(-0.19, -0.58, -0.04), sm);
  legRTip = mix(legRTip, vec3( 0.19, -0.58, -0.04), sm);
  float legL = sdRoundCone(sp, vec3(-0.08, -0.10, 0.0), legLTip, 0.245, 0.158);
  float legR = sdRoundCone(sp, vec3( 0.08, -0.10, 0.0), legRTip, 0.245, 0.158);

  float d = smin(core, topPt, 0.23);
  d = smin(d, armL, 0.23);
  d = smin(d, armR, 0.23);
  d = smin(d, legL, 0.22);
  d = smin(d, legR, 0.22);
  return d;
}

float sdStarlightCape(vec3 q, float t, AnimRig rig) {
  // 몽글 노란 별의 앞면은 깨끗하게 비우고 등 뒤에서만 펄럭이는 미니 별빛 망토 (슈퍼맨 비행 시 수평 강풍 · 회오리 상승 시 나선 휘날림)
  float sm = clamp(rig.supermanPose, 0.0, 1.0);
  float lenSpan = mix(0.48, 0.62, sm);
  float u = clamp((-0.09 - q.y) / lenSpan, 0.0, 1.0);
  float flightWind = (uWorldAnim == 21) ? 6.2
    : ((uWorldAnim == 17) ? 5.6
    : ((uWorldAnim == 16) ? mix(2.4, 5.4, sm)
    : ((uWorldAnim == 2) ? 2.6 : 0.0)));
  float spd = clamp(uMoveSpeed + flightWind, 0.0, 11.0);
  float billow = (0.10 + spd * 0.046 + max(0.0, -uJumpVel) * 0.048) * (u * u);
  float spiralWave = (uWorldAnim == 21) ? (sin(t * 14.0 - u * 7.5 + q.x * 5.0) * 0.055 * u) : 0.0;
  float flutter = sin(t * (4.1 + spd * 1.55) - u * 5.0 + q.x * 3.8) * (0.018 + spd * 0.009) * (u * u) + spiralWave;
  float hemY = mix(-0.56, -0.68, sm) + billow * mix(0.22, 0.08, sm);
  float midY = 0.5 * (-0.09 + hemY);
  float halfH = max(0.08, 0.5 * (-0.09 - hemY));
  float halfW = mix(0.24, mix(0.39, 0.43, sm), u);
  float curveZ = -0.37 - mix(0.11, 0.05, sm) * u - billow * mix(1.0, 0.42, sm) + flutter + 0.34 * q.x * q.x;
  vec3 cp = vec3(q.x, q.y - midY, q.z - curveZ);
  return sdRoundBox(cp, vec3(halfW, halfH, 0.015), 0.022) * 0.65;
}

vec2 mapAdmiralHats(vec2 res, vec3 hatOrigin, float hb, float sMin, int hatCode) {
  if (hatCode == 0) {
    vec3 cp = hatOrigin - vec3(0.0, hb, 0.0); cp.yz = rot2(-0.14 - hb * 0.65) * cp.yz;
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
  } else if (hatCode == 1) {
    // 황금 왕관 (Crown + 2차 바운스)
    vec3 crp = hatOrigin - vec3(0.0, 0.02 + hb, 0.0);
    crp.yz = rot2(-0.10 - hb * 0.65) * crp.yz;
    float band = sdEllipsoid(crp - vec3(0.0, 0.03, 0.0), vec3(0.36, 0.11, 0.34));
    float rim = sdEllipsoid(crp - vec3(0.0, -0.05, 0.0), vec3(0.39, 0.055, 0.37));
    float aCrown = atan(crp.z, crp.x);
    float seg = mod(aCrown + 3.1415926, 1.256637) - 0.6283185;
    float rXZ = length(crp.xz);
    vec3 sp = vec3(cos(seg) * rXZ, crp.y, sin(seg) * rXZ);
    float spike = sdRoundCone(sp, vec3(0.30, 0.05, 0.0), vec3(0.34, 0.27, 0.0), 0.075, 0.022);
    float orb = sdSphere(sp - vec3(0.34, 0.30, 0.0), 0.042);
    res = opU(res, vec2(min(min(band, rim), spike) * sMin, 4.0));
    res = opU(res, vec2(orb * sMin, 6.0));
  } else if (hatCode == 2) {
    // 탐험가 챙모자 (Explorer Hat + 2차 바운스)
    vec3 epHat = hatOrigin - vec3(0.0, 0.01 + hb, 0.0);
    epHat.yz = rot2(-0.12 - hb * 0.65) * epHat.yz;
    float brim = sdEllipsoid(epHat - vec3(0.0, -0.04, 0.02), vec3(0.68, 0.055, 0.64));
    float dome = sdEllipsoid(epHat - vec3(0.0, 0.14, 0.0), vec3(0.39, 0.23, 0.37));
    float leather = smin(brim, dome, 0.045);
    res = opU(res, vec2(leather * sMin, 8.0));
    float hatBand = sdEllipsoid(epHat - vec3(0.0, 0.025, 0.0), vec3(0.415, 0.052, 0.395));
    res = opU(res, vec2(hatBand * sMin, 4.0));
    vec3 fp = epHat - vec3(0.36, 0.21, -0.04);
    fp.xy = rot2(-0.48 - hb * 1.1) * fp.xy;
    float feather = sdEllipsoid(fp, vec3(0.045, 0.19, 0.085));
    res = opU(res, vec2(feather * sMin, 3.0));
  }
  return res;
}

float sdPlushOnly(vec3 p, AnimRig rig) {
  // 슈퍼마리오 스타 주인공은 털뭉치(퍼 쉘) 완전 비활성 — 매끈한 광택 3D 재질 유지
  if (uStarlight > 0.5) return 99.0;
  vec3 q = toLocal(p, rig);
  float sMin = min(rig.scale.x, min(rig.scale.y, rig.scale.z));
  float d = sdMongleBody(q, uShape) * sMin;
  if (uQuaker > 0) {
    vec3 pq = q - vec3(0.0, 0.08, 0.0);
    vec3 wl = pq - vec3(-0.44, -0.43, -0.03);
    wl.xy = rot2(0.28 + rig.wingFlapL) * wl.xy;
    float dwL = sdEllipsoid(wl - vec3(-0.14, -0.06, 0.0), vec3(0.20, 0.125, 0.13)) * sMin;
    vec3 wr = pq - vec3(0.44, -0.43, -0.03);
    wr.xy = rot2(-0.28 - rig.wingFlapR) * wr.xy;
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

vec2 mapWorldActivityProps(vec2 res, vec3 q, float sMin, float t, int worldAnim, int state, int activity, float propScale) {
  if (propScale <= 0.02) return res;
  float ps = clamp(propScale, 0.02, 1.2);

  // 월드 전용 이모트(wave/cheer/spin) 시 일반 몽글이도 귀여운 솜손 제스처 표현
  if (worldAnim == 8) {
    vec3 wp = (q - vec3(0.64, 0.26, 0.24)) / ps;
    wp.xy = rot2(sin(uAnimPhase * 11.5) * 0.42) * wp.xy;
    res = opU(res, vec2(sdSphere(wp - vec3(0.06, 0.10, 0.0), 0.13) * ps * sMin, 7.0));
  } else if (worldAnim == 9 || worldAnim == 10) {
    float lift = abs(sin(uAnimPhase * 7.2)) * 0.16;
    float paws = min(
      sdSphere(q - vec3(-0.68, 0.18 + lift, 0.22), 0.125 * ps),
      sdSphere(q - vec3( 0.68, 0.18 + lift, 0.22), 0.125 * ps)
    );
    res = opU(res, vec2(paws * sMin, 7.0));
  } else if (state == 1) {
    if (activity == 1) {
      // 생각 중 말풍선 1→2→3 점진적 생성 루프 (약 2.4초 주기)
      float cyc = fract(t * 0.42);
      float s1 = thoughtBubbleScale(cyc, 0.02, 0.15, 0.80, 0.92, 0.22) * ps;
      float s2 = thoughtBubbleScale(cyc, 0.20, 0.34, 0.83, 0.95, 0.24) * ps;
      float s3 = thoughtBubbleScale(cyc, 0.38, 0.54, 0.86, 0.98, 0.28) * ps;
      float pulse = sin(t * 3.8) * 0.022;
      float cloudBounce = sin(clamp((cyc - 0.38) / 0.16, 0.0, 1.0) * 3.1415926) * 0.032;
      float dB = 1e5;
      if (s1 > 0.02) dB = min(dB, sdSphere(q - vec3(0.46, 0.42 + pulse, 0.24), 0.048 * s1));
      if (s2 > 0.02) dB = min(dB, sdSphere(q - vec3(0.58, 0.56 + pulse * 1.4, 0.22), 0.072 * s2));
      if (s3 > 0.02) dB = min(dB, sdSphere(q - vec3(0.74, 0.72 + pulse * 1.8 + cloudBounce, 0.20), 0.105 * s3));
      if (dB < 1e4) res = opU(res, vec2(dB * sMin, 3.0));
      res = opU(res, vec2(sdSphere(q - vec3(-0.22, -0.34 + abs(sin(t * 4.5)) * 0.04, 0.48), 0.11 * ps) * sMin, 7.0));
    } else if (activity == 2) {
      vec3 bp = (q - vec3(0.0, -0.38, 0.56)) / ps; bp.yz = rot2(0.32) * bp.yz;
      vec3 pL = bp - vec3(-0.18, 0.0, 0.02); pL.xz = rot2(-0.28) * pL.xz;
      vec3 pR = bp - vec3( 0.18, 0.0, 0.02); pR.xz = rot2( 0.28) * pR.xz;
      res = opU(res, vec2(min(sdRoundBox(pL, vec3(0.17, 0.135, 0.02), 0.015), sdRoundBox(pR, vec3(0.17, 0.135, 0.02), 0.015)) * ps * sMin, 3.0));
      res = opU(res, vec2(min(sdSphere(q - vec3(-0.35, -0.42, 0.56), 0.10 * ps), sdSphere(q - vec3(0.35, -0.42 + max(0.0, sin(t * 2.8)) * 0.08, 0.56), 0.10 * ps)) * sMin, 7.0));
    } else if (activity == 3) {
      vec3 np = (q - vec3(-0.30, -0.42, 0.54)) / ps; np.yz = rot2(0.22) * np.yz;
      res = opU(res, vec2(sdRoundBox(np, vec3(0.19, 0.135, 0.022), 0.016) * ps * sMin, 3.0));
      vec3 sc = vec3(sin(t * 14.0) * 0.05, cos(t * 11.0) * 0.035, 0.0);
      vec3 pp = (q - (vec3(0.18, -0.30, 0.58) + sc)) / ps; pp.xy = rot2(-0.72) * pp.xy;
      res = opU(res, vec2(sdCapsule(pp, vec3(-0.23, 0.0, 0.0), vec3(0.23, 0.0, 0.0), 0.046) * ps * sMin, 6.0));
      res = opU(res, vec2(sdSphere(q - (vec3(0.26, -0.25, 0.56) + sc * 0.8), 0.10 * ps) * sMin, 7.0));
    } else if (activity == 4) {
      float lift = sin(t * 5.2) * 0.12;
      res = opU(res, vec2(min(sdSphere(q - vec3(-0.74, 0.08 + lift, 0.18), 0.12 * ps), sdSphere(q - vec3(0.74, 0.08 + lift, 0.18), 0.12 * ps)) * sMin, 7.0));
    } else if (activity == 5) {
      vec3 tp = (q - vec3(0.46, 0.04, 0.44)) / ps; tp.xy = rot2(0.32 + sin(t * 2.6) * 0.25) * tp.xy;
      res = opU(res, vec2(sdRoundCone(tp, vec3(-0.18, 0.0, 0.0), vec3(0.28, 0.0, 0.0), 0.055, 0.095) * ps * sMin, 5.0));
      res = opU(res, vec2(sdEllipsoid(tp - vec3(0.29, 0.0, 0.0), vec3(0.03, 0.09, 0.09)) * ps * sMin, 3.0));
      res = opU(res, vec2(sdSphere(q - vec3(0.44, -0.10, 0.45), 0.105 * ps) * sMin, 7.0));
    } else if (activity == 6) {
      vec3 wp = (q - vec3(0.66, 0.26, 0.22)) / ps; wp.xy = rot2(sin(t * 6.5) * 0.35) * wp.xy;
      res = opU(res, vec2(sdSphere(wp - vec3(0.05, 0.08, 0.0), 0.125) * ps * sMin, 7.0));
    }
  }
  return res;
}

vec2 mapScene(vec3 p, AnimRig rig) {
  vec3 q = toLocal(p, rig);
  float sMin = min(rig.scale.x, min(rig.scale.y, rig.scale.z));
  float t = uTime + uPhase;

  if (uStarlight > 0.5) {
    // mId == 11: 몽글몽글 소프트 새틴 쿠션 마리오 스타
    vec2 res = vec2(sdMarioStar(q, rig) * sMin, 11.0);

    // 등 뒤에서만 펄럭이는 3종 미니 망토 (uCape == 3이면 망토 없음)
    if (uCape != 3) {
      res = opU(res, vec2(sdStarlightCape(q, t, rig) * sMin, 9.0));
    }

    // 4종 모자 100% 호환 + 모자 없음 전용: 별 꼭짓점 주변을 은은히 맴도는 작은 별빛 반짝임 2기
    float hb = rig.hatBounce;
    if (uHat == 3) {
      vec3 sp = q - vec3(0.0, 0.68 + hb * 0.5, 0.0);
      vec3 m1 = vec3(cos(t * 2.2) * 0.29, sin(t * 3.1) * 0.052 + 0.03, sin(t * 2.2) * 0.29);
      vec3 m2 = vec3(cos(t * 2.2 + 3.14159) * 0.25, -sin(t * 2.7) * 0.042 - 0.02, sin(t * 2.2 + 3.14159) * 0.25);
      float motes = min(sdSphere(sp - m1, 0.033), sdSphere(sp - m2, 0.024));
      res = opU(res, vec2(motes * sMin, 10.0));
    } else {
      float hatY = (uHat == 1) ? 0.52 : 0.49;
      res = mapAdmiralHats(res, q - vec3(0.0, hatY, 0.0), hb, sMin, uHat);
    }
    return res;
  }

  vec2 res = vec2(sdMongleBody(q, uShape) * sMin, 0.0);

  if (uQuaker > 0) {
    vec3 pq = q - vec3(0.0, 0.08, 0.0);
    vec3 wl = pq - vec3(-0.44, -0.43, -0.03);
    wl.xy = rot2(0.28 + rig.wingFlapL) * wl.xy;
    float dwL = sdEllipsoid(wl - vec3(-0.14, -0.06, 0.0), vec3(0.20, 0.125, 0.13)) * sMin;
    vec3 wr = pq - vec3(0.44, -0.43, -0.03);
    wr.xy = rot2(-0.28 - rig.wingFlapR) * wr.xy;
    float dwR = sdEllipsoid(wr - vec3(0.14, -0.06, 0.0), vec3(0.20, 0.125, 0.13)) * sMin;
    res = opU(res, vec2(min(dwL, dwR), 7.0));

    vec3 el = pq - vec3(-0.38, -0.39, 0.06); el.xy = rot2(0.32) * el.xy;
    vec3 er = pq - vec3( 0.38, -0.39, 0.06); er.xy = rot2(-0.32) * er.xy;
    res = opU(res, vec2(min(sdRoundBox(el, vec3(0.105,0.036,0.072), 0.024), sdRoundBox(er, vec3(0.105,0.036,0.072), 0.024)) * sMin, 4.0));

    vec3 bp = pq - vec3(0.0, -0.16, 0.47);
    res = opU(res, vec2(sdRoundCone(bp, vec3(0.0, 0.048, -0.02), vec3(0.0, -0.082, 0.105), 0.090, 0.030) * sMin, 6.0));

    res = mapAdmiralHats(res, pq - vec3(0.0, 0.41, 0.0), rig.hatBounce, sMin, uHat);
  } else {
    if (uGiftHat >= 0 && uGiftHat < 3) {
      // 사령관 선물 모자 착용 (제독모·황금 왕관·탐험가 모자)
      float topY = shapeCrownY(uShape);
      float giftY = (uGiftHat == 1) ? (topY + 0.01) : (topY - 0.03);
      res = mapAdmiralHats(res, q - vec3(0.0, giftY, 0.0), rig.hatBounce, sMin, uGiftHat);
    } else if (uRole == 0) {
      vec3 sp = q - vec3(-0.56, 0.54 + rig.hatBounce * 0.6, 0.22);
      sp.yz = rot2(0.08) * sp.yz; sp.xz = rot2(-0.18) * sp.xz;
      res = opU(res, vec2(sdEllipsoid(sp, vec3(0.185, 0.185, 0.068)) * sMin, 4.0));
    } else if (uRole == 1) {
      float topY = shapeCrownY(uShape);
      vec3 tip = vec3(sin(t * 3.0) * 0.04, topY + 0.27 + rig.hatBounce * 0.5, 0.0);
      res = opU(res, vec2(sdCapsule(q, vec3(0.0, topY - 0.06, 0.0), tip, 0.032) * sMin, 5.0));
      res = opU(res, vec2(sdSphere(q - tip, 0.115) * sMin, 6.0));
    }

    if (
      uAnimBlend >= 0.999
      || (uPrevWorldAnim == uWorldAnim && uPrevState == uState && uPrevActivity == uActivity)
    ) {
      res = mapWorldActivityProps(res, q, sMin, t, uWorldAnim, uState, uActivity, 1.0);
    } else {
      float tb = smoothstep(0.0, 1.0, clamp(uAnimBlend, 0.0, 1.0));
      float scaleOut = 1.0 - smoothstep(0.0, 0.65, tb);
      float scaleIn = smoothstep(0.25, 1.0, tb);
      res = mapWorldActivityProps(res, q, sMin, t, uPrevWorldAnim, uPrevState, uPrevActivity, scaleOut);
      res = mapWorldActivityProps(res, q, sMin, t, uWorldAnim, uState, uActivity, scaleIn);
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

  float sphereR = uBoundRad - 0.02;
  float b = dot(ro, rd);
  float c = dot(ro, ro) - sphereR * sphereR;
  float disc = b * b - c;
  if (disc < 0.0) discard;

  float tStart = max(0.0, -b - sqrt(disc));
  float tEnd = -b + sqrt(disc);
  float camDist = length(ro) * uCharScale;
  int maxSteps = (camDist > 26.0) ? 28 : 52;
  float minStep = (camDist > 26.0) ? 0.014 : 0.008;
  AnimRig rig = computeAnim();
  float tAnim = uTime + uPhase;

  float t = tStart;
  float hitMat = -1.0;
  float tHit = tEnd;
  float minPlushD = 9.9;
  float minPlushT = tStart;

  for (int i = 0; i < 52; i++) {
    if (i >= maxSteps) break;
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
    t += max(h.x * 0.88, minStep);
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

    if (mId == 11) {
      // 슈퍼마리오 스타 (Power Star) 전용 매끈·광택·반짝이는 3D 플라스틱/세라믹 재질 (털 노이즈 0!)
      grazeMask = 0.0;

      vec3 nLoc = N;
      nLoc.xz = rot2(-rig.yawAdd) * nLoc.xz;
      nLoc.xy = rot2(-rig.roll) * nLoc.xy;
      nLoc.yz = rot2(rig.pitchAdd) * nLoc.yz;
      nLoc = normalize(nLoc);

      vec3 starAlbedo = uBaseCol;
      float tipBright = smoothstep(0.30, 0.74, length(q.xy));
      starAlbedo = mix(starAlbedo, mix(starAlbedo, vec3(1.0, 0.98, 0.78), 0.35), tipBright * 0.50);

      // 슈퍼마리오 스타 시그니처 세로로 길쭉한 검은 타원 눈(| |) + 5종 표정 + 복숭아 볼터치
      float eyeMask = 0.0;
      float eyeGlint = 0.0;
      if (q.z > 0.08 && nLoc.z > 0.16) {
        float frontFade = smoothstep(0.16, 0.36, nLoc.z);
        int expr = rig.exprMode;
        float blushAmt = clamp(max(max(uBlush, rig.blushAdd), (expr == 1) ? 0.78 : 0.0), 0.0, 1.0);
        float eyeY = 0.04;
        vec2 ep = q.xy - vec2(0.0, eyeY) - rig.eyeShift * 0.58;
        vec2 eL = ep - vec2(-0.132, 0.0);
        vec2 eR = ep - vec2( 0.132, 0.0);
        if (expr == 1) {
          // happy (^ ^ 반달 웃는 눈)
          float dArc = min(sdHappyEyeArc(eL), sdHappyEyeArc(eR));
          eyeMask = (1.0 - smoothstep(-0.007, 0.008, dArc)) * frontFade;
        } else if (expr == 2) {
          // sleepy (- - 감은 눈)
          float dSlp = min(sdSleepyEyeLine(eL), sdSleepyEyeLine(eR));
          eyeMask = (1.0 - smoothstep(-0.007, 0.008, dSlp)) * frontFade;
        } else if (expr == 3) {
          // surprised (◉ ◉ 크게 뜬 반짝 눈)
          float dEye = min(length(eL), length(eR)) - 0.096;
          eyeMask = (1.0 - smoothstep(-0.007, 0.008, dEye)) * frontFade;
          vec2 nearE = (length(eL) < length(eR)) ? eL : eR;
          float g1 = 1.0 - smoothstep(0.022, 0.036, length(nearE - vec2(-0.022, 0.032)));
          float g2 = 1.0 - smoothstep(0.011, 0.020, length(nearE - vec2(0.024, -0.024)));
          eyeGlint = clamp(g1 + g2 * 0.85, 0.0, 1.0) * eyeMask;
        } else if (expr == 4) {
          // focused (집중 눈)
          float dEyeL = max(sdRoundedBox2(eL, vec2(0.046, 0.112), 0.044), eL.y - (0.042 - eL.x * 0.30));
          float dEyeR = max(sdRoundedBox2(eR, vec2(0.046, 0.112), 0.044), eR.y - (0.042 + eR.x * 0.30));
          eyeMask = (1.0 - smoothstep(-0.007, 0.008, min(dEyeL, dEyeR))) * frontFade;
          vec2 nearE = (length(eL) < length(eR)) ? eL : eR;
          eyeGlint = (1.0 - smoothstep(0.014, 0.024, length(nearE - vec2(-0.010, 0.012)))) * eyeMask;
        } else {
          // normal (슈퍼마리오 스타 시그니처 세로 길쭉 검은 타원 눈 | | + 상단 하얀 하이라이트)
          float hE = max(0.015, 0.128 * rig.eyeBlink);
          float dEye = min(sdRoundedBox2(eL, vec2(0.044, hE), 0.042),
                           sdRoundedBox2(eR, vec2(0.044, hE), 0.042));
          eyeMask = (1.0 - smoothstep(-0.007, 0.008, dEye)) * frontFade;
          vec2 nearE = (length(eL) < length(eR)) ? eL : eR;
          float gTop = 1.0 - smoothstep(0.015, 0.027, length(nearE - vec2(-0.009, 0.056 * rig.eyeBlink)));
          eyeGlint = gTop * eyeMask;
        }
        float finalBlush = max(0.28, blushAmt * 0.68);
        float bM = min(
          length((q.xy - vec2(-0.240, eyeY - 0.105)) / vec2(0.092, 0.052)),
          length((q.xy - vec2( 0.240, eyeY - 0.105)) / vec2(0.092, 0.052))
        );
        starAlbedo = mix(starAlbedo, vec3(0.99, 0.56, 0.54), (1.0 - smoothstep(0.20, 1.0, bM)) * finalBlush * frontFade);
      }

      vec3 baseLin = toLinear(starAlbedo);
      float diff = clamp((dot(N, L1) + 0.48) / 1.48, 0.0, 1.0);
      vec3 H1 = normalize(L1 + V);
      // 딱딱한 플라스틱이나 털뭉치가 아닌 보송한 소프트 새틴·말랑 실리콘 광택
      float specSoft = pow(max(dot(N, H1), 0.0), 22.0);
      float specBroad = pow(max(dot(N, H1), 0.0), 8.5);
      float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.1);

      vec3 shadowCol = baseLin * vec3(0.62, 0.49, 0.38);
      vec3 litCol = baseLin * 1.08 + vec3(0.02);
      coreCol = mix(shadowCol, litCol, pow(diff, 0.88));
      coreCol += baseLin * 0.14;
      coreCol += vec3(1.0, 0.97, 0.84) * (specSoft * 0.22 + specBroad * 0.24);
      coreCol += mix(baseLin, vec3(1.0, 0.96, 0.72), 0.60) * rim * 0.54;
      if (rig.auraBoost > 0.001) {
        // 별빛 비행 · 화이팅 충전 · 회오리 상승 · 유성 급강하 황금 에너지 림/오라 글로우
        float pulseSpd = (uWorldAnim == 17 || uWorldAnim == 21) ? 14.0 : 6.2;
        float auraPulse = 0.88 + 0.14 * sin(tAnim * pulseSpd);
        coreCol += vec3(1.0, 0.89, 0.38) * (0.24 * rig.auraBoost + rim * (0.96 * rig.auraBoost)) * auraPulse;
      }

      if (eyeMask > 0.001) {
        vec3 eyeGloss = vec3(0.012, 0.012, 0.022) + vec3(0.30) * specSoft * 0.30;
        eyeGloss = mix(eyeGloss, vec3(1.12, 1.11, 1.08), eyeGlint);
        coreCol = mix(coreCol, eyeGloss, eyeMask);
      }
    } else if (mId == 0 || mId == 7) {
      bool isWing = (mId == 7);
      vec3 pCol = plushColorAt(q, isWing);
      grazeMask = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.5) * 0.78;

      vec3 nLoc = N;
      nLoc.xz = rot2(-rig.yawAdd) * nLoc.xz;
      nLoc.xy = rot2(-rig.roll) * nLoc.xy;
      nLoc.yz = rot2(rig.pitchAdd) * nLoc.yz;
      nLoc = normalize(nLoc);

      float eyeMask = 0.0;
      float eyeGlint = 0.0;
      if (!isWing && q.z > 0.08 && nLoc.z > 0.14) {
        float frontFade = smoothstep(0.14, 0.34, nLoc.z);
        int expr = rig.exprMode;
        float blushAmt = clamp(max(max(uBlush, rig.blushAdd), (expr == 1) ? 0.78 : 0.0), 0.0, 1.0);
        if (uQuaker > 0) {
          vec3 pq = q - vec3(0.0, 0.08, 0.0);
          vec2 ep = pq.xy - vec2(0.0, -0.015) - rig.eyeShift * 0.55;
          vec2 eL = vec2(ep.x + 0.185, ep.y);
          vec2 eR = vec2(ep.x - 0.185, ep.y);
          if (expr == 1) {
            // happy (^ ^ 반달 웃는 눈)
            float dArc = min(sdHappyEyeArc(eL), sdHappyEyeArc(eR));
            eyeMask = (1.0 - smoothstep(-0.008, 0.009, dArc)) * frontFade;
          } else if (expr == 2) {
            // sleepy (- - 평온히 감은 눈)
            float dSlp = min(sdSleepyEyeLine(eL), sdSleepyEyeLine(eR));
            eyeMask = (1.0 - smoothstep(-0.008, 0.009, dSlp)) * frontFade;
          } else if (expr == 3) {
            // surprised (◉ ◉ 크게 뜬 반짝 눈)
            float dRing = min(length(eL), length(eR)) - 0.128;
            float dPupil = min(length(eL), length(eR)) - 0.104;
            pCol = mix(pCol, vec3(0.98, 0.98, 0.96), (1.0 - smoothstep(-0.008, 0.008, dRing)) * frontFade);
            eyeMask = (1.0 - smoothstep(-0.008, 0.008, dPupil)) * frontFade;
            vec2 nearE = (length(eL) < length(eR)) ? eL : eR;
            float g1 = 1.0 - smoothstep(0.026, 0.040, length(nearE - vec2(-0.032, 0.034)));
            float g2 = 1.0 - smoothstep(0.012, 0.022, length(nearE - vec2(0.034, -0.028)));
            eyeGlint = clamp(g1 + g2 * 0.85, 0.0, 1.0) * eyeMask;
          } else if (expr == 4) {
            // focused (작업 집중 눈 — 살짝 내린 윗눈꺼풀)
            float dRing = min(length(eL), length(eR)) - 0.108;
            float dPupil = min(length(eL), length(eR)) - 0.088;
            float browCutL = eL.y - (0.026 - eL.x * 0.24);
            float browCutR = eR.y - (0.026 + eR.x * 0.24);
            float browCut = (length(eL) < length(eR)) ? browCutL : browCutR;
            dRing = max(dRing, browCut);
            dPupil = max(dPupil, browCut);
            pCol = mix(pCol, vec3(0.97, 0.97, 0.95), (1.0 - smoothstep(-0.008, 0.008, dRing)) * frontFade);
            eyeMask = (1.0 - smoothstep(-0.008, 0.008, dPupil)) * frontFade;
            vec2 nearE = (length(eL) < length(eR)) ? eL : eR;
            eyeGlint = (1.0 - smoothstep(0.018, 0.030, length(nearE - vec2(-0.024, 0.006)))) * eyeMask;
          } else {
            // normal (기본 둥근 눈 + 자연 깜빡임)
            vec2 eLb = vec2(eL.x, eL.y / max(rig.eyeBlink, 0.10));
            vec2 eRb = vec2(eR.x, eR.y / max(rig.eyeBlink, 0.10));
            float dRing = min(length(eLb), length(eRb)) - 0.112;
            float dPupil = min(length(eLb), length(eRb)) - 0.090;
            pCol = mix(pCol, vec3(0.97, 0.97, 0.95), (1.0 - smoothstep(-0.008, 0.008, dRing)) * frontFade);
            eyeMask = (1.0 - smoothstep(-0.008, 0.008, dPupil)) * frontFade;
            vec2 nearE = (length(eLb) < length(eRb)) ? eLb : eRb;
            eyeGlint = (1.0 - smoothstep(0.022, 0.034, length(nearE - vec2(-0.028, 0.028)))) * eyeMask;
          }
          float baseBlush = (uQuaker != 2) ? 0.44 : 0.0;
          float finalBlush = max(baseBlush, blushAmt * 0.68);
          if (finalBlush > 0.02) {
            float bM = min(
              length((pq.xy - vec2(-0.29, -0.18)) / vec2(0.105, 0.064)),
              length((pq.xy - vec2( 0.29, -0.18)) / vec2(0.105, 0.064))
            );
            pCol = mix(pCol, vec3(0.97, 0.52, 0.62), (1.0 - smoothstep(0.25, 1.0, bM)) * finalBlush * frontFade);
          }
        } else {
          float eyeY = (uShape == 4) ? -0.10 : (uShape == 9 ? -0.04 : 0.01);
          vec2 ep = q.xy - vec2(0.0, eyeY) - rig.eyeShift;
          vec2 eL = ep - vec2(-0.182, 0.0);
          vec2 eR = ep - vec2( 0.182, 0.0);
          if (expr == 1) {
            // happy (^ ^ 반달 웃는 눈)
            float dArc = min(sdHappyEyeArc(eL), sdHappyEyeArc(eR));
            eyeMask = (1.0 - smoothstep(-0.008, 0.009, dArc)) * frontFade;
          } else if (expr == 2) {
            // sleepy (- - 감은 눈)
            float dSlp = min(sdSleepyEyeLine(eL), sdSleepyEyeLine(eR));
            eyeMask = (1.0 - smoothstep(-0.008, 0.009, dSlp)) * frontFade;
          } else if (expr == 3) {
            // surprised (◉ ◉ 크게 뜬 반짝 눈)
            float dEye = min(length(eL), length(eR)) - 0.106;
            eyeMask = (1.0 - smoothstep(-0.008, 0.009, dEye)) * frontFade;
            vec2 nearE = (length(eL) < length(eR)) ? eL : eR;
            float g1 = 1.0 - smoothstep(0.024, 0.038, length(nearE - vec2(-0.030, 0.032)));
            float g2 = 1.0 - smoothstep(0.012, 0.020, length(nearE - vec2(0.032, -0.026)));
            eyeGlint = clamp(g1 + g2 * 0.80, 0.0, 1.0) * eyeMask;
          } else if (expr == 4) {
            // focused (집중 눈)
            float dEyeL = max(sdRoundedBox2(eL, vec2(0.080, 0.084), 0.068), eL.y - (0.036 - eL.x * 0.22));
            float dEyeR = max(sdRoundedBox2(eR, vec2(0.080, 0.084), 0.068), eR.y - (0.036 + eR.x * 0.22));
            float dEye = min(dEyeL, dEyeR);
            eyeMask = (1.0 - smoothstep(-0.008, 0.009, dEye)) * frontFade;
          } else {
            // normal (기본 알약형 눈 + 자연 깜빡임)
            float hE = max(0.018, 0.122 * rig.eyeBlink);
            float dEye = min(sdRoundedBox2(eL, vec2(0.078, hE), 0.074),
                             sdRoundedBox2(eR, vec2(0.078, hE), 0.074));
            eyeMask = (1.0 - smoothstep(-0.008, 0.009, dEye)) * frontFade;
            vec2 nearE = (length(eL) < length(eR)) ? eL : eR;
            eyeGlint = (1.0 - smoothstep(0.016, 0.028, length(nearE - vec2(-0.024, 0.040 * rig.eyeBlink)))) * eyeMask * 0.72;
          }
          if (blushAmt > 0.02) {
            float bM = min(
              length((q.xy - vec2(-0.285, eyeY - 0.135)) / vec2(0.112, 0.066)),
              length((q.xy - vec2( 0.285, eyeY - 0.135)) / vec2(0.112, 0.066))
            );
            pCol = mix(pCol, vec3(0.98, 0.50, 0.62), (1.0 - smoothstep(0.22, 1.0, bM)) * blushAmt * 0.58 * frontFade);
          }
        }
      }
      grazeMask *= (1.0 - eyeMask);

      vec3 baseLin = toLinear(pCol);
      vec3 Nf = N;
      if (camDist < 24.0) {
        vec3 fp = q * 38.0;
        float n0 = noise3(fp);
        vec3 fGrad = vec3(noise3(fp + vec3(0.18,0,0)) - n0, noise3(fp + vec3(0,0.18,0)) - n0, noise3(fp + vec3(0,0,0.18)) - n0);
        Nf = normalize(N + fGrad * 0.62);
      }
      float diff = clamp((dot(Nf, L1) + 0.38) / 1.38, 0.0, 1.0);
      vec3 deepCol = pow(max(baseLin, vec3(0.002)), vec3(1.38)) * 0.16;
      vec3 hiCol = baseLin * 1.12 + vec3(0.024);
      coreCol = mix(deepCol, hiCol, pow(diff, 1.05));
      float velvet = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.5);
      coreCol += mix(baseLin, vec3(0.95), 0.25) * velvet * 0.34;
      if (camDist < 24.0) {
        coreCol *= (1.0 + (noise3(q * 105.0) - 0.5) * 0.14);
      }
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
        if (uQuaker == 0 && uStarlight < 0.5 && uRole == 0 && (uGiftHat < 0 || uGiftHat >= 3)) {
          vec3 sp = q - vec3(-0.56, 0.54 + rig.hatBounce * 0.6, 0.22); sp.yz = rot2(0.08)*sp.yz; sp.xz = rot2(-0.18)*sp.xz;
          if (sp.z > 0.02) {
            float sm = 1.0 - smoothstep(-0.008, 0.008, sdStar5_2D(vec2(sp.x, -sp.y), 0.132, 0.45));
            gold = mix(gold, vec3(0.015, 0.012, 0.022), sm * 0.95);
          }
        }
        coreCol = gold;
      }
      else if (mId == 5) coreCol = toLinear(vec3(0.16, 0.20, 0.32)) * (0.35 + 0.82 * wrap);
      else if (mId == 6) {
        float antennaBoost = (uQuaker == 0 && uRole == 1 && (uGiftHat < 0 || uGiftHat >= 3)) ? 1.25 : 1.0;
        coreCol = toLinear((uQuaker > 0) ? vec3(0.97, 0.67, 0.30) : vec3(1.0, 0.88, 0.34)) * (0.45 + 0.70 * wrap) * antennaBoost;
      }
      else if (mId == 8) {
        coreCol = toLinear(vec3(0.54, 0.33, 0.17)) * (0.36 + 0.80 * wrap) + vec3(0.35, 0.22, 0.10) * spec * 0.18;
      }
      else if (mId == 9) {
        // 3종 벨벳 미니 망토 (0=별빛 딥네이비 · 1=영웅 진홍 · 2=숲 에메랄드) + 황금 트림 + 등 중앙 황금 문양
        float capeRim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.4);
        vec3 baseCloth = (uCape == 1)
          ? vec3(0.68, 0.11, 0.16)
          : (uCape == 2 ? vec3(0.11, 0.38, 0.22) : vec3(0.11, 0.14, 0.34));
        vec3 rimTint = (uCape == 1)
          ? vec3(0.98, 0.46, 0.34)
          : (uCape == 2 ? vec3(0.42, 0.84, 0.54) : vec3(0.38, 0.48, 0.92));
        vec3 capeVelvet = toLinear(baseCloth) * (0.42 + 0.72 * wrap)
          + toLinear(rimTint) * capeRim * 0.30;
        float smCape = clamp(rig.supermanPose, 0.0, 1.0);
        float lenSpan = mix(0.48, 0.62, smCape);
        float flightWind = (uWorldAnim == 21) ? 6.2
          : ((uWorldAnim == 17) ? 5.6
          : ((uWorldAnim == 16) ? mix(2.4, 5.4, smCape)
          : ((uWorldAnim == 2) ? 2.6 : 0.0)));
        float spd = clamp(uMoveSpeed + flightWind, 0.0, 11.0);
        float capeU = clamp((-0.09 - q.y) / lenSpan, 0.0, 1.0);
        float billow = (0.10 + spd * 0.046 + max(0.0, -uJumpVel) * 0.048) * (capeU * capeU);
        float hemY = mix(-0.56, -0.68, smCape) + billow * mix(0.22, 0.08, smCape);
        float hemDist = q.y - hemY;
        float trimBand = (uCape == 1) ? 0.046 : 0.036;
        float goldTrim = (1.0 - smoothstep(trimBand, trimBand + 0.024, hemDist)) * smoothstep(-0.18, -0.32, q.z);
        float backFace = smoothstep(-0.12, -0.32, q.z);
        float dBackStar = sdStar5_2D(vec2(q.x, q.y + 0.33), (uCape == 1) ? 0.132 : 0.118, (uCape == 2) ? 0.52 : 0.45);
        float backStarMask = (1.0 - smoothstep(-0.008, 0.010, dBackStar)) * backFace;
        float starHalo = (1.0 - smoothstep(0.0, 0.095, max(dBackStar, 0.0))) * backFace * 0.30;
        float tw1 = 0.65 + 0.35 * sin(tAnim * 4.2 + 0.5);
        float tw2 = 0.65 + 0.35 * sin(tAnim * 3.7 + 2.4);
        float dots = (1.0 - smoothstep(0.013, 0.022, length(vec2(abs(q.x) - 0.18, q.y + 0.24)))) * tw1
                   + (1.0 - smoothstep(0.011, 0.020, length(vec2(abs(q.x) - 0.20, q.y + 0.42)))) * tw2;
        dots *= backFace * ((uCape == 1) ? 0.35 : 1.0);
        vec3 goldGlow = toLinear(vec3(0.98, 0.80, 0.28)) * (0.58 + 0.55 * wrap) + vec3(0.95, 0.86, 0.52) * spec * 0.50;
        vec3 sparkTint = (uCape == 2) ? vec3(0.76, 0.98, 0.56) : vec3(0.98, 0.84, 0.40);
        coreCol = capeVelvet + toLinear(sparkTint) * (starHalo + dots * 0.72);
        coreCol = mix(coreCol, goldGlow, clamp(max(goldTrim, backStarMask), 0.0, 1.0));
      }
      else if (mId == 10) {
        // 모자 없음 전용: 별 머리 주변을 은은히 맴도는 작은 별빛 반짝임 입자
        float pulse = 0.92 + 0.14 * sin(tAnim * 3.6);
        vec3 starGold = toLinear(vec3(1.0, 0.90, 0.42)) * (0.82 + 0.38 * wrap) * pulse
          + vec3(1.0, 0.96, 0.74) * spec * 0.65;
        coreCol = starGold;
      }
      else coreCol = toLinear(uBaseCol) * (0.35 + 0.80 * wrap);
    }
    coreAlpha = 1.0;
  }

  float furLod = 1.0 - smoothstep(16.0, 22.0, camDist);
  float furLen = (uStarlight > 0.5) ? 0.0 : 0.082 * uFuzz * furLod;
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
        // 모자 챙 위쪽으로는 몸통 솜결이 새어 나오지 않도록 마스킹 (선물 모자 착용 일반 몽글이 포함)
        float capMask = ((uQuaker > 0 || uStarlight > 0.5) && uHat != 3)
          ? smoothstep(0.42 + rig.hatBounce, 0.28 + rig.hatBounce, qs.y)
          : ((uGiftHat >= 0 && uGiftHat < 3)
            ? smoothstep(shapeCrownY(uShape) + 0.04 + rig.hatBounce, shapeCrownY(uShape) - 0.10 + rig.hatBounce, qs.y)
            : 1.0);
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

export type WorldAnimMode =
  | "idle"
  | "walk"
  | "sprint"
  | "jump"
  | "sit"
  | "doze"
  | "sleep"
  | "talk"
  | "wave"
  | "cheer"
  | "spin"
  | "shake"
  | "work-edit"
  | "work-read"
  | "work-think"
  | "work-run"
  | "fly"
  | "dive"
  | "takeoff-charge"
  | "takeoff-ascend"
  | "hero-land";

export type WorldExpression = "normal" | "happy" | "sleepy" | "surprised" | "focused";

export interface MongleActorRigParams {
  readonly baseId: number;
  readonly shape: MongleShape;
  readonly tone: IdentityTone;
  readonly quaker: QuakerMorph | null;
  /** true이면 주인공 전용 「⭐ 별빛 요정 몽글이 (Starlight Spirit)」 SDF 외형으로 렌더링한다. */
  readonly starlight?: boolean | undefined;
  readonly role: MongleRole;
  readonly scale: number;
}

export interface MongleActorRig {
  readonly group: Group;
  /** 제독 아바타 바디 톤 · 모자 · 망토를 실시간 변경한다. */
  setAdmiralStyle(tone: IdentityTone, hat: WorldAdmiralHat, cape?: WorldAdmiralCape): void;
  /** 제독 망토(`starlight` / `hero` / `forest` / `none`)를 실시간 변경한다. */
  setCape(cape: WorldAdmiralCape): void;
  /** 사령관/제독 선물 모자(`admiral` / `crown` / `explorer` / `none`, `null`이면 기본 외형 복원)를 실시간 적용한다. */
  setHat(hat: WorldAdmiralHat | null): void;
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
    readonly worldAnim?: WorldAnimMode | undefined;
    readonly expression?: WorldExpression | undefined;
    readonly animPhase?: number | undefined;
    readonly moveSpeed?: number | undefined;
    readonly jumpVel?: number | undefined;
    readonly landSquash?: number | undefined;
    readonly lookYaw?: number | undefined;
    readonly lookPitch?: number | undefined;
    readonly blush?: number | undefined;
    readonly hatBounce?: number | undefined;
    readonly flightRoll?: number | undefined;
    readonly flightPitch?: number | undefined;
  }): void;
  dispose(): void;
}

const sharedCubeGeo = new BoxGeometry(2, 2, 2);
sharedCubeGeo.computeBoundingSphere();
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

// 모든 액터가 완전히 동일하게 사용하는 보조 머티리얼은 모듈 스코프에서 1회 공유한다.
const sharedShadowMat = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
const sharedContactMat = new ShaderMaterial({
  glslVersion: GLSL3,
  transparent: true,
  depthWrite: false,
  vertexShader: CONTACT_AO_VERTEX,
  fragmentShader: CONTACT_AO_FRAGMENT,
});
const sharedCrateMat = new MeshStandardMaterial({ color: 0xfbbf24, emissive: 0xf59e0b, emissiveIntensity: 0.55, roughness: 0.35 });
const sharedBeaconMat = new MeshStandardMaterial({ color: 0xfde047, emissive: 0xfacc15, emissiveIntensity: 1.45, roughness: 0.22 });

const ADMIRAL_HAT_CODE: Readonly<Record<WorldAdmiralHat, number>> = {
  admiral: 0,
  crown: 1,
  explorer: 2,
  none: 3,
};

const ADMIRAL_CAPE_CODE: Readonly<Record<WorldAdmiralCape, number>> = {
  starlight: 0,
  hero: 1,
  forest: 2,
  none: 3,
};

const WORLD_ANIM_CODE: Readonly<Record<WorldAnimMode, number>> = {
  idle: 0,
  walk: 1,
  sprint: 2,
  jump: 3,
  sit: 4,
  doze: 5,
  sleep: 6,
  talk: 7,
  wave: 8,
  cheer: 9,
  spin: 10,
  shake: 11,
  "work-edit": 12,
  "work-read": 13,
  "work-think": 14,
  "work-run": 15,
  fly: 16,
  dive: 17,
  "takeoff-charge": 20,
  "takeoff-ascend": 21,
  "hero-land": 22,
};

const WORLD_EXPRESSION_CODE: Readonly<Record<WorldExpression, number>> = {
  normal: 0,
  happy: 1,
  sleepy: 2,
  surprised: 3,
  focused: 4,
};

function resolveStarlightRgb(tone: IdentityTone): readonly [number, number, number] {
  if (tone === "amber") {
    // 맑고 선명한 슈퍼마리오 스타 골드-옐로우
    return [1.0, 0.86, 0.22];
  }
  const rgb = PLUSH_VIVID_TONES[tone];
  return [
    rgb[0] * 0.82 + 0.18,
    rgb[1] * 0.82 + 0.18,
    rgb[2] * 0.82 + 0.18,
  ];
}

let rigReducedMotionBound = false;
let rigReducedMotion = false;

function isRigReducedMotion(): boolean {
  if (!rigReducedMotionBound && typeof window !== "undefined" && typeof window.matchMedia === "function") {
    rigReducedMotionBound = true;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    rigReducedMotion = mq.matches;
    mq.addEventListener("change", (ev) => {
      rigReducedMotion = ev.matches;
    });
  }
  return rigReducedMotion;
}

function resolveRigTransitionDuration(prevAnim: number, nextAnim: number): number {
  if (isRigReducedMotion()) return 0;
  // 시네마틱 이륙·급강하·히어로 착지 시퀀스는 타이밍 정확도를 위해 즉시/초단기 전이
  if (
    (prevAnim === 20 && nextAnim === 21)
    || (prevAnim === 21 && nextAnim === 16)
    || nextAnim === 20
    || nextAnim === 17
    || nextAnim === 22
  ) {
    return 0.06;
  }
  // 플레이어 지상 이동·질주·점프 전이는 민첩하게(0.16초)
  if (prevAnim <= 3 && nextAnim <= 3 && (prevAnim !== 0 || nextAnim !== 0)) {
    return 0.16;
  }
  // 작업 활동·상태·감정표현 전이는 부드럽게(0.34초)
  return 0.34;
}

export function createMongleActorRig(params: MongleActorRigParams): MongleActorRig {
  const group = new Group();
  const isStarlight = params.starlight === true;
  const boundRad = isStarlight ? 1.62 : 1.56;
  const initRgb = isStarlight
    ? resolveStarlightRgb(params.tone)
    : params.quaker
      ? QUAKER_PASTEL_TONES[params.quaker]
      : PLUSH_VIVID_TONES[params.tone];
  const initR = initRgb[0];
  const initG = initRgb[1];
  const initB = initRgb[2];

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
      uBoundRad: { value: boundRad },
      uCharYaw: { value: 0 },
      uTime: { value: 0 },
      uPhase: { value: params.baseId * 1.73 },
      uFuzz: { value: 1.05 },
      uShape: { value: params.quaker ? 10 : MONGLE_SHAPE_CODE[params.shape] },
      uQuaker: { value: params.quaker ? QUAKER_MORPH_CODE[params.quaker] : 0 },
      uStarlight: { value: isStarlight ? 1.0 : 0.0 },
      uState: { value: 0 },
      uActivity: { value: 0 },
      uPrevState: { value: 0 },
      uPrevActivity: { value: 0 },
      uRole: { value: MONGLE_ROLE_CODE[params.role] },
      uHat: { value: 0 },
      uGiftHat: { value: -1 },
      uCape: { value: 0 },
      uWorldAnim: { value: 0 },
      uPrevWorldAnim: { value: 0 },
      uAnimBlend: { value: 1.0 },
      uExpression: { value: 0 },
      uAnimPhase: { value: 0 },
      uMoveSpeed: { value: 0 },
      uJumpVel: { value: 0 },
      uLandSquash: { value: 0 },
      uLookYaw: { value: 0 },
      uLookPitch: { value: 0 },
      uBlush: { value: 0 },
      uHatBounce: { value: 0 },
      uFlightRoll: { value: 0 },
      uFlightPitch: { value: 0 },
      uBaseCol: { value: new Vector3(initR, initG, initB) },
      uWorldLightDir: { value: new Vector3(0.5, 0.85, 0.4) },
      uWorldTint: { value: new Vector3(1, 1, 1) },
    },
    vertexShader: ACTOR_VERTEX,
    fragmentShader: ACTOR_FRAGMENT,
  });

  // 실제 바운딩 큐브 크기(boundRad * scale)와 일치시켜 카메라 프러스텀 컬링을 정확히 활성화한다.
  const volumeMesh = new Mesh(sharedCubeGeo, mat);
  volumeMesh.scale.setScalar(boundRad * params.scale);
  volumeMesh.frustumCulled = true;
  volumeMesh.renderOrder = 10;
  group.add(volumeMesh);

  // 보이지 않는 그림자 캐스터 코어
  const shadowCaster = new Mesh(sharedShadowSphereGeo, sharedShadowMat);
  shadowCaster.castShadow = true;
  shadowCaster.scale.setScalar(params.scale);
  group.add(shadowCaster);

  // 발밑 소프트 그라데이션 밀착 접지 그림자 (Contact AO — 각진 테두리 없음)
  const contactDisc = new Mesh(sharedContactGeo, sharedContactMat);
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
  const crateMesh = new Mesh(sharedCrateGeo, sharedCrateMat);
  crateMesh.visible = false;
  group.add(crateMesh);

  const beaconMesh = new Mesh(sharedBeaconGemGeo, sharedBeaconMat);
  beaconMesh.visible = false;
  group.add(beaconMesh);

  let poseInitialized = false;
  let currWorldAnimCode = 0;
  let currStateCode = 0;
  let currActivityCode = 0;
  let prevWorldAnimCode = 0;
  let prevStateCode = 0;
  let prevActivityCode = 0;
  let animBlend = 1.0;
  let animBlendDur = 0.34;
  let lastPoseElapsed = -1;

  return {
    group,
    setAdmiralStyle(tone, hat, cape) {
      const baseCol = mat.uniforms["uBaseCol"]!.value as Vector3;
      if (isStarlight) {
        const [r, g, b] = resolveStarlightRgb(tone);
        baseCol.set(r, g, b);
      } else {
        const rgb = PLUSH_VIVID_TONES[tone];
        // 퀘이커 솜결의 포근한 파스텔 감을 살리면서 8색 톤을 또렷하게 반영
        baseCol.set(
          rgb[0] * 0.80 + 0.20,
          rgb[1] * 0.80 + 0.20,
          rgb[2] * 0.80 + 0.20,
        );
      }
      mat.uniforms["uHat"]!.value = ADMIRAL_HAT_CODE[hat];
      if (cape !== undefined) {
        mat.uniforms["uCape"]!.value = ADMIRAL_CAPE_CODE[cape];
      }
    },
    setCape(cape) {
      mat.uniforms["uCape"]!.value = ADMIRAL_CAPE_CODE[cape];
    },
    setHat(hat) {
      if (isStarlight || params.quaker) {
        mat.uniforms["uHat"]!.value = hat === null ? 0 : ADMIRAL_HAT_CODE[hat];
        mat.uniforms["uGiftHat"]!.value = -1;
      } else {
        const code = hat === null || hat === "none" ? -1 : ADMIRAL_HAT_CODE[hat];
        mat.uniforms["uGiftHat"]!.value = code;
        if (code >= 0) {
          mat.uniforms["uHat"]!.value = code;
        }
      }
    },
    updatePose(opts) {
      const centerY = opts.groundY + opts.liftY + 0.62 * params.scale;
      charCenter.set(opts.x, centerY, opts.z);
      volumeMesh.position.copy(charCenter);
      shadowCaster.position.set(opts.x, centerY - 0.08 * params.scale, opts.z);
      const showContact = opts.liftY < 2.2;
      contactDisc.visible = showContact;
      if (showContact) {
        contactDisc.position.set(opts.x, opts.groundY + 0.025, opts.z);
        const shrink = Math.max(0.35, 1 - opts.liftY * 0.35);
        contactDisc.scale.set(params.scale * shrink, params.scale * shrink, params.scale * shrink);
      }

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

      const nextStateCode = MONGLE_STATE_CODE[opts.state];
      const nextActivityCode = opts.activity ? MONGLE_ACTIVITY_CODE[opts.activity] : 0;
      const nextWorldAnimCode = opts.worldAnim ? WORLD_ANIM_CODE[opts.worldAnim] : 0;

      if (!poseInitialized) {
        poseInitialized = true;
        currWorldAnimCode = nextWorldAnimCode;
        currStateCode = nextStateCode;
        currActivityCode = nextActivityCode;
        prevWorldAnimCode = nextWorldAnimCode;
        prevStateCode = nextStateCode;
        prevActivityCode = nextActivityCode;
        animBlend = 1.0;
      } else if (
        nextWorldAnimCode !== currWorldAnimCode
        || nextStateCode !== currStateCode
        || nextActivityCode !== currActivityCode
      ) {
        const dur = resolveRigTransitionDuration(currWorldAnimCode, nextWorldAnimCode);
        if (dur <= 0.001) {
          prevWorldAnimCode = nextWorldAnimCode;
          prevStateCode = nextStateCode;
          prevActivityCode = nextActivityCode;
          animBlend = 1.0;
        } else {
          prevWorldAnimCode = currWorldAnimCode;
          prevStateCode = currStateCode;
          prevActivityCode = currActivityCode;
          animBlend = 0.0;
          animBlendDur = dur;
        }
        currWorldAnimCode = nextWorldAnimCode;
        currStateCode = nextStateCode;
        currActivityCode = nextActivityCode;
      }

      const poseDt = lastPoseElapsed >= 0 ? Math.max(0, Math.min(0.1, opts.elapsed - lastPoseElapsed)) : 0;
      lastPoseElapsed = opts.elapsed;
      if (animBlend < 1.0) {
        animBlend = Math.min(1.0, animBlend + poseDt / Math.max(0.01, animBlendDur));
        if (animBlend >= 1.0) {
          prevWorldAnimCode = currWorldAnimCode;
          prevStateCode = currStateCode;
          prevActivityCode = currActivityCode;
        }
      }

      mat.uniforms["uViewProj"]!.value = opts.viewProj;
      mat.uniforms["uCharYaw"]!.value = opts.yaw;
      mat.uniforms["uTime"]!.value = opts.elapsed;
      mat.uniforms["uFuzz"]!.value = opts.fuzz;
      mat.uniforms["uState"]!.value = nextStateCode;
      mat.uniforms["uActivity"]!.value = nextActivityCode;
      mat.uniforms["uPrevState"]!.value = prevStateCode;
      mat.uniforms["uPrevActivity"]!.value = prevActivityCode;
      mat.uniforms["uWorldAnim"]!.value = nextWorldAnimCode;
      mat.uniforms["uPrevWorldAnim"]!.value = prevWorldAnimCode;
      mat.uniforms["uAnimBlend"]!.value = animBlend;
      mat.uniforms["uExpression"]!.value = opts.expression ? WORLD_EXPRESSION_CODE[opts.expression] : 0;
      mat.uniforms["uAnimPhase"]!.value = opts.animPhase ?? 0;
      mat.uniforms["uMoveSpeed"]!.value = opts.moveSpeed ?? 0;
      mat.uniforms["uJumpVel"]!.value = opts.jumpVel ?? 0;
      mat.uniforms["uLandSquash"]!.value = opts.landSquash ?? 0;
      mat.uniforms["uLookYaw"]!.value = opts.lookYaw ?? 0;
      mat.uniforms["uLookPitch"]!.value = opts.lookPitch ?? 0;
      mat.uniforms["uBlush"]!.value = opts.blush ?? 0;
      mat.uniforms["uHatBounce"]!.value = opts.hatBounce ?? 0;
      mat.uniforms["uFlightRoll"]!.value = opts.flightRoll ?? 0;
      mat.uniforms["uFlightPitch"]!.value = opts.flightPitch ?? 0;
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
      ringMat.dispose();
    },
  };
}
