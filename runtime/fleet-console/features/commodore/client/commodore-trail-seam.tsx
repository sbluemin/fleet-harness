import { useRef, useState } from "react";

/**
 * 기록 본문과 목표 칸 사이의 세로 이음매.
 * Repository 분할선과 같은 문법(1px 선, 손잡이, ←→·Home·End·Enter, 더블클릭)이지만
 * 그 부품은 repository 플러그인 안이라 가져오지 않는다. 넓이 계산과 저장은 주인이 갖는다.
 */

export const TRAIL_WIDTH_DEFAULT = 260;
export const TRAIL_WIDTH_MIN = 200;
const TRAIL_WIDTH_KEY = "fleet.objectives.commodore.trailWidth";
const TRAIL_WIDTH_STORED_MAX = 4000;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/** 기기별 저장. 읽기가 실패하거나 값이 쓰레기면 기본 넓이다. */
export function readTrailWidth(): number {
  try {
    const raw = localStorage.getItem(TRAIL_WIDTH_KEY);
    if (raw === null) return TRAIL_WIDTH_DEFAULT;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < TRAIL_WIDTH_MIN || value > TRAIL_WIDTH_STORED_MAX) return TRAIL_WIDTH_DEFAULT;
    return Math.round(value);
  } catch {
    return TRAIL_WIDTH_DEFAULT;
  }
}

export function writeTrailWidth(width: number): void {
  try {
    localStorage.setItem(TRAIL_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // 저장이 막혀도 화면은 지금 넓이로 그린다.
  }
}

/** 본문 넓이의 절반. 아직 재기 전이면 최대를 말하지 않는다. 절반이 최소보다 좁으면 최소를 최대로 둔다. */
export function trailWidthMax(bodyWidth: number): number | undefined {
  if (!(bodyWidth > 0)) return undefined;
  return Math.max(TRAIL_WIDTH_MIN, Math.round(bodyWidth * 0.5));
}

export function clampTrailWidth(width: number, bodyWidth: number): number {
  const max = trailWidthMax(bodyWidth);
  const rounded = Math.round(width);
  if (max === undefined) return Math.max(TRAIL_WIDTH_MIN, rounded);
  return Math.max(TRAIL_WIDTH_MIN, Math.min(max, rounded));
}

export function CommodoreTrailSeam({
  label,
  value,
  bodyWidth,
  onChange,
  onReset,
}: {
  readonly label: string;
  readonly value: number;
  readonly bodyWidth: number;
  readonly onChange: (width: number) => void;
  readonly onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const max = trailWidthMax(bodyWidth);
  const bodyWidthRef = useRef(bodyWidth);
  bodyWidthRef.current = bodyWidth;
  const drag = useRef<{ pointerId: number; startX: number; startW: number } | null>(null);
  const rangeValid = max !== undefined && max >= TRAIL_WIDTH_MIN;
  const ariaNow = rangeValid ? Math.max(TRAIL_WIDTH_MIN, Math.min(max, Math.round(value))) : Math.max(TRAIL_WIDTH_MIN, Math.round(value));
  const stepTo = (next: number) => onChange(clampTrailWidth(next, bodyWidthRef.current));
  return (
    <div
      className={`objectives-commodore-trail-seam${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={rangeValid ? TRAIL_WIDTH_MIN : undefined}
      aria-valuemax={rangeValid ? Math.round(max) : undefined}
      aria-valuenow={rangeValid ? ariaNow : undefined}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startW: value };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || event.pointerId !== current.pointerId) return;
        stepTo(current.startW + (current.startX - event.clientX));
      }}
      onPointerUp={(event) => {
        if (!drag.current || event.pointerId !== drag.current.pointerId) return;
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onDoubleClick={(event) => { event.preventDefault(); onReset(); }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
        // 목표 칸은 선의 오른쪽이다. ← 이 칸을 넓히고 → 이 줄인다.
        if (event.key === "ArrowLeft") { event.preventDefault(); stepTo(value + step); }
        else if (event.key === "ArrowRight") { event.preventDefault(); stepTo(value - step); }
        else if (event.key === "Home") { event.preventDefault(); stepTo(TRAIL_WIDTH_MIN); }
        else if (event.key === "End" && max !== undefined) { event.preventDefault(); stepTo(max); }
        else if (event.key === "Enter") { event.preventDefault(); onReset(); }
      }}
    >
      <span className="objectives-commodore-trail-seam-pill" aria-hidden="true" />
      <span className="objectives-commodore-trail-seam-readout" aria-hidden="true">{ariaNow}px</span>
    </div>
  );
}
