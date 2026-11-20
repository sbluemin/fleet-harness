import {
  BackSide,
  Color,
  DirectionalLight,
  FogExp2,
  GLSL3,
  Group,
  HemisphereLight,
  Mesh,
  PointLight,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";

import type { WorldTimeMode } from "../../shared/world-types.js";

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

void main() {
  vec3 dir = normalize(vWorldDir);
  float h = clamp(dir.y * 0.88 + 0.12, 0.0, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyTop, pow(h, 0.62));

  // 태양 및 황혼 코로나
  float sunDot = dot(dir, normalize(uSunDir));
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

  fragColor = vec4(col, 1.0);
}
`;

export interface SkyAndLightingRig {
  readonly group: Group;
  readonly sunDir: Vector3;
  readonly avatarWorldTint: Vector3;
  nightFactor: number;
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

function resolveTargetBlend(mode: WorldTimeMode, elapsed: number): number {
  if (mode === "day") return 0.0;
  if (mode === "sunset") return 0.5;
  if (mode === "night") return 1.0;
  if (mode === "cycle") return 0.5 - 0.5 * Math.cos(elapsed * 0.24);
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  if (hour >= 8 && hour <= 16.5) return 0.0;
  if (hour > 16.5 && hour < 19.5) return ((hour - 16.5) / 3.0) * 0.85;
  if (hour >= 5.5 && hour < 8) return (1 - (hour - 5.5) / 2.5) * 0.85;
  return 1.0;
}

export function createSkyAndLighting(scene: Scene): SkyAndLightingRig {
  const group = new Group();
  // 넓은 초원과 원경 산맥이 또렷하게 보이도록 안개 농도를 완만하게 설정
  const fog = new FogExp2(0xd6f0ff, 0.0052);
  scene.fog = fog;

  const uSkyTop = new Color(0x3fa4f8);
  const uSkyHorizon = new Color(0xd8f2ff);
  const sunDir = new Vector3(0.50, 0.84, 0.46).normalize();
  const avatarWorldTint = new Vector3(1.02, 1.01, 0.99);

  const skyGeo = new SphereGeometry(165, 32, 20);
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

  // 주 태양/달 그림자 광원 (넓은 초원 마을 전역을 커버)
  const dirLight = new DirectionalLight(0xfff7e4, 1.95);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.camera.near = 2;
  dirLight.shadow.camera.far = 115;
  const shadowBounds = 38;
  dirLight.shadow.camera.left = -shadowBounds;
  dirLight.shadow.camera.right = shadowBounds;
  dirLight.shadow.camera.top = shadowBounds;
  dirLight.shadow.camera.bottom = -shadowBounds;
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

  // 플레이어 휴대용 랜턴 광원
  const playerLantern = new PointLight(0xffe484, 0, 8.5, 1.7);
  group.add(playerLantern);

  // 가로등 광원 풀 (최대 8개)
  const lampLights = Array.from({ length: 8 }, () => {
    const pl = new PointLight(0xffe074, 0, 9.5, 1.7);
    group.add(pl);
    return pl;
  });

  // 지휘관 머리 위 안테나 광원 풀 (최대 4개)
  const antennaLights = Array.from({ length: 4 }, () => {
    const pl = new PointLight(0xffe866, 0, 6.5, 1.8);
    group.add(pl);
    return pl;
  });

  scene.add(group);

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
    setStreetlampAnchors(anchors) {
      lampLights.forEach((pl, idx) => {
        const a = anchors[idx];
        if (a) {
          pl.position.set(a.x, a.y + 1.85, a.z);
        } else {
          pl.position.set(0, -50, 0);
        }
      });
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
      dirLight.position.copy(sunDir).multiplyScalar(48);
      fog.color.copy(uSkyHorizon);
      skyMat.uniforms["uNight"]!.value = night;
      skyMat.uniforms["uTime"]!.value = elapsed;

      const lampStrength = Math.max(0, (night - 0.22) / 0.78);
      campfireLight.intensity = (1.5 + lampStrength * 3.0) + Math.sin(elapsed * 12) * 0.32;

      playerLantern.position.set(playerPos.x, playerPos.y + 1.15, playerPos.z);
      playerLantern.intensity = lampStrength * 1.75;

      lampLights.forEach((pl, idx) => {
        pl.intensity = pl.position.y > -10 ? lampStrength * (idx < 3 ? 2.3 : 1.9) : 0;
      });
      antennaLights.forEach((pl, idx) => {
        const cp = commanderPositions[idx];
        if (cp && lampStrength > 0.05) {
          pl.position.set(cp.x, cp.y + 1.45, cp.z);
          pl.intensity = lampStrength * 1.85;
        } else {
          pl.intensity = 0;
        }
      });
    },
    dispose() {
      skyGeo.dispose();
      skyMat.dispose();
      scene.remove(group);
    },
  };

  return rig;
}
