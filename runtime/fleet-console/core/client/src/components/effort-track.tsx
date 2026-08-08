import { useCallback, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";

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

  const slots = useMemo<readonly EffortSlot[]>(() => {
    const chips = row.chips ?? [];
    const byId = new Map<string, OperationLaunchVariantChip>(chips.map((chip) => [chip.id, chip]));
    // 축이 없으면 내놓은 단만이 축이다. 축에 없는 단이 오면 뒤에 붙여, 사다리가 늘어도 조용히 사라지지 않는다.
    const axis = row.effortAxis ?? chips.map((chip) => chip.id);
    const extra = chips.map((chip) => chip.id).filter((id) => !axis.includes(id));
    const rungs = [...axis, ...extra].map((id) => ({
      id,
      label: byId.get(id)?.label ?? id.toUpperCase(),
      selectable: byId.has(id),
    }));
    return [{ id: null, label: autoLabel, selectable: true }, ...rungs];
  }, [autoLabel, row.chips, row.effortAxis]);

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

  const fromPointer = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || last === 0) return;
    const rect = track.getBoundingClientRect();
    const span = rect.width - EDGE * 2;
    if (span <= 0) return;
    const ratio = Math.max(0, Math.min((event.clientX - rect.left - EDGE) / span, 1));
    commit(nearestSelectable(Math.round(ratio * last)));
  }, [commit, last, nearestSelectable]);

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
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          fromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          fromPointer(event);
        }}
      >
        <span className="effort-track-fill" style={{ width: `calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))` }} aria-hidden="true" />
        <span className="effort-track-stops" aria-hidden="true">
          {slots.map((slot, position) => (
            <span
              key={slot.id ?? "auto"}
              className="effort-track-stop"
              style={{ left: last === 0 ? "50%" : `${(position / last) * 100}%` }}
              data-filled={position <= index && !isAuto ? true : undefined}
              data-gap={slot.selectable ? undefined : true}
            />
          ))}
        </span>
        <span
          className="effort-track-knob"
          style={{ left: `calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))` }}
          aria-hidden="true"
        />
      </div>
      <span className="effort-track-value" data-auto={isAuto}>{current.label}</span>
    </div>
  );
}

/** 기억해 둔 강도가 이 모델 사다리에 없으면 비운 상태로 떨어진다. */
export function resolveRowEffort(row: OperationLaunchVariantRow | null, effort: string | null): string | null {
  if (!row || effort === null) return null;
  return row.chips?.some((chip) => chip.id === effort) ? effort : null;
}
