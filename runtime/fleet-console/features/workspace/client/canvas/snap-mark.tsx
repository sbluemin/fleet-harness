// 스냅 표식 — 이 패널이 분할의 **어느 칸**에 붙어 있는지 그리는 글리프 하나. 캡션과 사이드바 칩이
// 같은 컴포넌트를 쓴다: 표식을 두 곳에서 따로 그리던 동안(캡션은 문자 ▣, 칩은 ::after) 폰트마다
// 무게·정렬이 흔들렸고 둘 다 어느 칸인지는 말하지 못했다.
//
// 바깥 둥근 사각형은 아레나, 안쪽 채움은 칸의 분수 좌표(snapHold.zones[assignment]) 그대로다 —
// 칸이 바뀌면 글리프도 바뀐다. 배치 선택(SnapPresetGlyph)과 같은 도형 문법이라 화면 전체가
// "아레나 사각형 + 칸" 하나로 읽힌다.

import { useT, type CoreMessageKey } from "../../../../core/client/src/i18n/index.js";
import { snapZoneName, type SnapZoneFraction, type SnapZoneName } from "./snap-layouts.js";

// 12×12 상자에서 아레나 선은 1..11, 칸이 놓이는 안쪽은 2.5..9.5 — 선 두께와 숨 쉴 틈을 뺀 값이다.
const INNER_ORIGIN = 2.5;
const INNER_SIZE = 7;
// 얇은 칸(⅓ 열·사분면)이 알약으로 뭉개지지 않게 반지름은 짧은 변을 따라 줄인다.
const MAX_RADIUS = 1;
// 한 픽셀 아래로 내려가면 칸이 선으로 보인다 — 아주 좁은 칸도 면으로 남긴다.
const MIN_SIDE = 1;

const ZONE_NAME_KEY: Readonly<Record<SnapZoneName, CoreMessageKey>> = {
  full: "canvas.snap.markFull",
  left: "canvas.snap.markLeft",
  center: "canvas.snap.markCenter",
  right: "canvas.snap.markRight",
  top: "canvas.snap.markTop",
  bottom: "canvas.snap.markBottom",
  topLeft: "canvas.snap.markTopLeft",
  topCenter: "canvas.snap.markTopCenter",
  topRight: "canvas.snap.markTopRight",
  bottomLeft: "canvas.snap.markBottomLeft",
  bottomCenter: "canvas.snap.markBottomCenter",
  bottomRight: "canvas.snap.markBottomRight",
};

export interface SnapMarkProps {
  /** 이 패널이 든 칸의 아레나 분수 — [x, y, width, height]. */
  readonly zone: SnapZoneFraction;
}

export function SnapMark({ zone }: SnapMarkProps) {
  const t = useT();
  const [fx, fy, fw, fh] = zone;
  const width = Math.max(MIN_SIDE, fw * INNER_SIZE);
  const height = Math.max(MIN_SIDE, fh * INNER_SIZE);
  const radius = Math.min(MAX_RADIUS, Math.min(width, height) / 2.5);
  const label = t("canvas.snap.markTitle", { zone: t(ZONE_NAME_KEY[snapZoneName(zone)]) });
  return (
    <svg className="canvas-snap-mark" width="12" height="12" viewBox="0 0 12 12" role="img" aria-label={label}>
      <title>{label}</title>
      <rect className="canvas-snap-mark-arena" x="1" y="1" width="10" height="10" rx="2" />
      <rect
        className="canvas-snap-mark-zone"
        x={INNER_ORIGIN + fx * INNER_SIZE}
        y={INNER_ORIGIN + fy * INNER_SIZE}
        width={width}
        height={height}
        rx={radius}
      />
    </svg>
  );
}
