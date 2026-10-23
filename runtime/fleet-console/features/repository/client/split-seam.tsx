import { useCallback, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";

/**
 * 분할 이음매 — Repository의 모든 분할선이 쓰는 한 부품.
 *
 * 선은 1px, 손잡이(pill)가 "여기를 끌 수 있다"를 말하고, 잡는 영역은 선 양쪽으로 ±5px다.
 * 드래그 수명(포인터 캡처·저장)은 주인이 소유한다 — 이 부품은 그리기, 접근성 속성,
 * 키보드 조절 요청만 맡는다. 어느 축이든 같은 문법이라 소유자마다 다르던 ARIA·키보드
 * 계약이 여기서 하나로 모인다.
 */

export type SeamOrientation = "horizontal" | "vertical";

export interface SplitSeamProps {
  /** horizontal = 위·아래를 나누는 가로 선(row-resize), vertical = 좌·우를 나누는 세로 선(col-resize). */
  readonly orientation: SeamOrientation;
  readonly label: string;
  readonly value?: number;
  readonly min?: number;
  readonly max?: number;
  readonly dragging?: boolean;
  /** 드래그·키보드 조절 중 선 곁에 띄우는 읽기 값(px·%·정착점·한계 사유). */
  readonly readout?: ReactNode;
  /** 읽기 값이 한계 사유일 때 — coral로 그린다. */
  readonly limit?: boolean;
  readonly className?: string;
  readonly onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  /** 키보드 한 걸음. 양수는 첫 번째 페인이 커지는 방향(가로 선은 ↑, 세로 선은 →). */
  readonly onStep?: (delta: number) => void;
  /** Home / End — 소유자가 정착점(또는 최소·최대)으로 해석한다. */
  readonly onJump?: (edge: "start" | "end") => void;
  /** Enter 또는 더블클릭 — 소유자가 토글(절반 ⇄ 전체 등)로 해석한다. */
  readonly onToggle?: () => void;
}

/**
 * 이음매가 사는 컨테이너의 한 축 크기 — ARIA 최대치를 실제 값으로 말하기 위해 잰다.
 * 포커스 가능한 separator가 aria-valuemax 없이 px 값을 내면 암묵 최대 100과 모순된다.
 */
export function useSeamContainerSize(ref: RefObject<HTMLElement | null>, axis: "width" | "height", active = true): number | undefined {
  const [size, setSize] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = active ? ref.current : null;
    if (!element) { setSize(undefined); return; }
    const measure = () => setSize(element.getBoundingClientRect()[axis]);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, axis, ref]);
  return size;
}

export const SEAM_KEY_STEP = 16;
export const SEAM_KEY_STEP_LARGE = 64;

export function seamKeyDelta(key: string, orientation: SeamOrientation, shiftKey: boolean): number | null {
  const step = shiftKey ? SEAM_KEY_STEP_LARGE : SEAM_KEY_STEP;
  if (orientation === "horizontal") {
    if (key === "ArrowUp") return step;
    if (key === "ArrowDown") return -step;
    return null;
  }
  if (key === "ArrowRight") return step;
  if (key === "ArrowLeft") return -step;
  return null;
}

export function SplitSeam({ orientation, label, value, min, max, dragging = false, readout, limit = false, className, onPointerDown, onStep, onJump, onToggle }: SplitSeamProps) {
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = seamKeyDelta(event.key, orientation, event.shiftKey);
    if (delta !== null && onStep) { event.preventDefault(); onStep(delta); return; }
    if ((event.key === "Home" || event.key === "End") && onJump) { event.preventDefault(); onJump(event.key === "Home" ? "start" : "end"); return; }
    if (event.key === "Enter" && onToggle) { event.preventDefault(); onToggle(); }
  }, [onJump, onStep, onToggle, orientation]);
  const interactive = Boolean(onStep || onJump || onToggle);
  // ARIA 값은 실제 범위 안에서만 말한다 — 저장값이 줄어든 컨테이너보다 크면 화면은 최대치로 그려지므로 그 값을,
  // 최대가 최소보다 작은(짧은 컨테이너) 경우는 범위 자체가 성립하지 않으므로 세 값을 모두 비운다.
  const rangeMin = min ?? 0;
  const rangeValid = max !== undefined && max >= rangeMin;
  const ariaNow = rangeValid && value !== undefined ? Math.round(Math.max(rangeMin, Math.min(max, value))) : undefined;
  return <div
    className={`repository-seam repository-seam--${orientation}${dragging ? " is-dragging" : ""}${className ? ` ${className}` : ""}`}
    role="separator"
    aria-orientation={orientation}
    aria-label={label}
    aria-valuenow={ariaNow}
    aria-valuemin={rangeValid && min !== undefined ? Math.round(min) : undefined}
    aria-valuemax={rangeValid ? Math.round(max) : undefined}
    tabIndex={interactive ? 0 : undefined}
    onPointerDown={onPointerDown}
    onKeyDown={interactive ? handleKeyDown : undefined}
    onDoubleClick={onToggle ? (event) => { event.preventDefault(); onToggle(); } : undefined}
  >
    <span className="repository-seam-pill" aria-hidden="true" />
    {readout !== undefined && readout !== null && <span className={`repository-seam-readout${limit ? " is-limit" : ""}`} aria-hidden="true">{readout}</span>}
  </div>;
}
