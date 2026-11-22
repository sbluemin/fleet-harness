/**
 * 더 월드 시냇물(Brook) 및 4개 목교의 단일 진실 곡선 기하학.
 *
 * `meadow-scene.ts`(3D 지형·수면·목교), `world-projection.ts`(마을·구역 수로 회피),
 * `world-minimap.tsx`(전략 지도 시냇물/다리 SVG)가 모두 이 모듈을 공유해
 * 지형·물길·다리·미니맵이 100% 일치한다.
 */

export const BROOK_SPAN_HALF_X = 86;

export interface BrookSample {
  readonly centerZ: number;
  readonly halfWidth: number;
}

export interface BrookBridgeSpec {
  readonly id: "east-central" | "west-central" | "east-outer" | "west-outer";
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly halfSpan: number;
  readonly deckHalfWidth: number;
  readonly walkHalfWidth: number;
  readonly isOuter: boolean;
}

/**
 * 자연스러운 지브리풍 S자 곡류 시냇물 중심선 및 가변 강폭.
 *
 * - 서쪽 산기슭(`z≈9.4`) → 서부 완만한 만곡(`z≈15`) → 중앙 광장 남측 목교(`z≈10.5`)
 *   → 동부 큰 만곡 & 연못(`z≈20.2`) → 동쪽 산기슭(`z≈8.3`)으로 흐르며
 *   중앙 광장 및 전 12개 사령관 마을 앵커와 여유 간격을 유지한다.
 */
export function brookProfile(x: number): BrookSample {
  const centerZ = 14.2
    - Math.cos(x * 0.068) * 4.2
    + Math.sin(x * 0.036 + 0.35) * 4.4
    + Math.sin(x * 0.135 - 0.7) * 1.5;

  // 동쪽 큰 만곡 연못(`x≈18`) + 서쪽 작은 웅덩이(`x≈-34`), 다리 지점은 건너기 좋게 슬림하게 유지
  const eastPond = Math.exp(-Math.pow((x - 19.5) / 6.2, 2)) * 2.15;
  const westPond = Math.exp(-Math.pow((x + 31.0) / 5.4, 2)) * 1.55;
  const gentleBreath = 0.28 * Math.sin(x * 0.08 + 0.6);
  const halfWidth = Math.max(1.35, 1.55 + eastPond + westPond + gentleBreath);
  return { centerZ, halfWidth };
}

/** 시냇물 중심선의 수치 접선 기울기 `dz/dx` (목교 수직 정렬용). */
export function brookSlope(x: number): number {
  const eps = 0.25;
  return (brookProfile(x + eps).centerZ - brookProfile(x - eps).centerZ) / (eps * 2);
}

function makeBridge(
  id: BrookBridgeSpec["id"],
  x: number,
  isOuter: boolean,
): BrookBridgeSpec {
  const bp = brookProfile(x);
  const slope = brookSlope(x);
  // 다리 진행축(+localZ)이 강 접선(1, slope)에 직교하도록 yaw 산출
  const yaw = Math.atan(slope);
  const halfSpan = Math.max(isOuter ? 3.5 : 3.7, bp.halfWidth + 1.85);
  return {
    id,
    x,
    z: bp.centerZ,
    yaw,
    halfSpan,
    deckHalfWidth: isOuter ? 1.55 : 1.75,
    walkHalfWidth: isOuter ? 1.45 : 1.62,
    isOuter,
  };
}

/** 중앙 목교 2기 + 외곽 순환 산책로 목교 2기 (총 4기). */
export const BROOK_BRIDGES: readonly BrookBridgeSpec[] = [
  makeBridge("east-central", 8.6, false),
  makeBridge("west-central", -11.5, false),
  makeBridge("east-outer", 47.0, true),
  makeBridge("west-outer", -46.5, true),
];

/** 좌표에서 시냇물 중심선까지의 근사 최단 거리(공간 음향·배치 클리어존용). */
export function distanceToBrookEdge(x: number, z: number): number {
  const clampedX = Math.max(-BROOK_SPAN_HALF_X, Math.min(BROOK_SPAN_HALF_X, x));
  const bp = brookProfile(clampedX);
  const dx = x - clampedX;
  const dz = z - bp.centerZ;
  return Math.max(0, Math.hypot(dx, dz) - bp.halfWidth);
}
