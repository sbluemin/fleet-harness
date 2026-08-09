import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { OperationLaunchVariantChip, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";

/** 트랙 좌우 안쪽 여백 — 손잡이 반지름과 같아야 양 끝 스톱에서 손잡이가 트랙을 넘지 않는다. */
const EDGE = 13;

interface EffortSlot {
  readonly id: string | null;
  readonly label: string;
  /** 이 자리를 고를 수 있는가. 모델이 내놓지 않은 단은 자리만 지키고 비어 있다. */
  readonly selectable: boolean;
}

export interface EffortTrackProps {
  readonly row: OperationLaunchVariantRow;
  /** 선택된 강도. `null`은 강도를 비운 상태(모델 기본값)다. */
  readonly value: string | null;
  readonly onChange: (effort: string | null) => void;
  /** 강도를 비운 상태를 트랙 맨 앞 자리로 노출한다. */
  readonly autoLabel: string;
  readonly ariaLabel: string;
  readonly autoValueText: string;
  readonly className?: string;
}

/**
 * 강도 사다리를 하나의 축으로 세운 트랙. 목록과 달리 축은 단들 사이의 거리까지 말하므로,
 * 모델이 내놓지 않은 단도 자리를 지킨다 — low/high/max만 있는 모델에서 셋을 균등히 벌리면
 * high가 한가운데 서서, 실제로는 3/5 지점인 단을 절반이라고 말하게 된다.
 */
export function EffortTrack({ row, value, onChange, autoLabel, ariaLabel, autoValueText, className }: EffortTrackProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const slots = useMemo<readonly EffortSlot[]>(() => {
    const byId = new Map<string, OperationLaunchVariantChip>((row.chips ?? []).map((chip) => [chip.id, chip]));
    const rungs = ladderRungs(row).map((id) => ({
      id,
      label: byId.get(id)?.label ?? id.toUpperCase(),
      selectable: byId.has(id),
    }));
    return [{ id: null, label: autoLabel, selectable: true }, ...rungs];
  }, [autoLabel, row]);

  const last = slots.length - 1;
  const index = Math.max(0, slots.findIndex((slot) => slot.id === value));
  const current = slots[index]!;
  const isAuto = current.id === null;

  const nearestSelectable = useCallback((target: number): number => {
    const bounded = Math.max(0, Math.min(target, last));
    if (slots[bounded]?.selectable) return bounded;
    for (let step = 1; step <= slots.length; step += 1) {
      if (slots[bounded - step]?.selectable) return bounded - step;
      if (slots[bounded + step]?.selectable) return bounded + step;
    }
    return index;
  }, [index, last, slots]);

  const commit = useCallback((next: number) => {
    const slot = slots[next];
    if (!slot || slot.id === current.id) return;
    onChange(slot.id);
  }, [current.id, onChange, slots]);

  const indexFromPointer = useCallback((clientX: number): number | null => {
    const track = trackRef.current;
    if (!track || last === 0) return null;
    const rect = track.getBoundingClientRect();
    const span = rect.width - EDGE * 2;
    if (span <= 0) return null;
    const ratio = Math.max(0, Math.min((clientX - rect.left - EDGE) / span, 1));
    return nearestSelectable(Math.round(ratio * last));
  }, [last, nearestSelectable]);

  const fromPointer = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const next = indexFromPointer(event.clientX);
    if (next !== null) commit(next);
  }, [commit, indexFromPointer]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" || event.key === "ArrowDown"
      ? -1
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : 0;
    let next: number | null = null;
    // 방향키는 그 방향으로 고를 수 있는 다음 단까지 건너뛴다 — 비어 있는 자리에 멈추지 않는다.
    if (direction !== 0) {
      for (let i = index + direction; i >= 0 && i <= last; i += direction) {
        if (slots[i]!.selectable) { next = i; break; }
      }
    }
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = nearestSelectable(last);
    if (next === null) return;
    event.preventDefault();
    // 트랙은 메뉴 안에 산다. 방향키가 위로 새면 메뉴가 항목 이동으로 받아 함께 움직인다.
    event.stopPropagation();
    commit(next);
  }, [commit, index, last, nearestSelectable, slots]);

  const ratio = last === 0 ? 0 : index / last;

  return (
    <div className={`effort-track-shell${className ? ` ${className}` : ""}`}>
      <div
        ref={trackRef}
        className="effort-track"
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={index}
        aria-valuetext={isAuto ? autoValueText : current.label}
        data-at-max={index === last && !isAuto ? true : undefined}
        // 자동은 사다리의 최소 단이 아니라 "사다리를 쓰지 않음"이다. 파선 테두리·빈 손잡이·채움 0이
        // 한 어휘로 그것을 말한다 — 채움이 조금이라도 남으면 맨 왼쪽 단을 고른 것으로 읽힌다.
        data-auto={isAuto ? true : undefined}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          fromPointer(event);
        }}
        onPointerMove={(event) => {
          const next = indexFromPointer(event.clientX);
          if (next !== null) setPreviewIndex(next);
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          fromPointer(event);
        }}
        onPointerLeave={() => setPreviewIndex(null)}
        onPointerCancel={() => setPreviewIndex(null)}
      >
        {/* 자동은 폭 0이다. 손잡이 여백(EDGE)만큼이라도 남기면 트랙 왼쪽 끝에 brass 조각이 비쳐,
            비운 상태가 최소 강도를 고른 것처럼 보인다. */}
        <span
          className="effort-track-fill"
          style={{ width: isAuto ? 0 : `calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))` }}
          aria-hidden="true"
        />
        <span className="effort-track-stops" aria-hidden="true">
          {slots.map((slot, position) => (
            <span
              key={slot.id ?? "auto"}
              className="effort-track-stop"
              style={{ left: last === 0 ? "50%" : `${(position / last) * 100}%` }}
              data-filled={position <= index && !isAuto ? true : undefined}
              data-gap={slot.selectable ? undefined : true}
              data-previewed={position === previewIndex ? true : undefined}
            />
          ))}
        </span>
        <span
          className="effort-track-knob"
          style={{ left: `calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))` }}
          data-auto={isAuto ? true : undefined}
          aria-hidden="true"
        />
      </div>
      {/* 단계 톤은 CSS가 이 속성 하나로 읽는다 — 라벨 문자열은 번역·모델마다 달라 색의 기준이 될 수 없다. */}
      <span className="effort-track-value" data-auto={isAuto} data-effort-level={current.id ?? "auto"}>
        {current.label}
      </span>
    </div>
  );
}

/**
 * 이 행의 강도 사다리를 낮은 단부터 늘어놓는다. 축이 없으면 내놓은 단만이 축이고, 축에 없는 단이
 * 오면 뒤에 붙여 사다리가 늘어도 조용히 사라지지 않는다.
 */
function ladderRungs(row: OperationLaunchVariantRow): readonly string[] {
  const offered = (row.chips ?? []).map((chip) => chip.id);
  const axis = row.effortAxis ?? offered;
  return [...axis, ...offered.filter((id) => !axis.includes(id))];
}

/**
 * 사다리 위 이 강도의 자리. 트랙을 열지 않고도 몇 번째 단인지 보여야 하는 표식(캔버스 실행 메뉴의
 * 강도 손잡이)이 쓴다. 자동은 0단이다 — 사다리를 쓰지 않는 상태이지 최소 단이 아니다.
 */
export function effortLadderPosition(row: OperationLaunchVariantRow, effort: string | null): {
  readonly rung: number;
  readonly total: number;
} {
  const rungs = ladderRungs(row);
  return { rung: effort === null ? 0 : rungs.indexOf(effort) + 1, total: rungs.length };
}

/** 기억해 둔 강도가 이 모델 사다리에 없으면 비운 상태로 떨어진다. */
export function resolveRowEffort(row: OperationLaunchVariantRow | null, effort: string | null): string | null {
  if (!row || effort === null) return null;
  return row.chips?.some((chip) => chip.id === effort) ? effort : null;
}
