import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

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
  /**
   * 이미 고른 단에 다시 눌렀을 때. 드래그로 다른 단을 거쳐 돌아온 경우는 호출하지 않는다 —
   * 값을 고르는 제스처와 "이 값으로 확정" 제스처를 갈라야 한다. 생략하면 같은 단 재클릭은
   * 아무 일도 없다(Quick Launch처럼 제출이 다른 자리인 표면).
   */
  readonly onConfirmCurrent?: () => void;
  /** 강도를 비운 상태를 트랙 맨 앞 자리로 노출한다. */
  readonly autoLabel: string;
  readonly ariaLabel: string;
  readonly autoValueText: string;
  readonly apexToggleLabel?: string;
  readonly className?: string;
}

/**
 * 강도 사다리를 하나의 축으로 세운 트랙. 목록과 달리 축은 단들 사이의 거리까지 말하므로,
 * 모델이 내놓지 않은 단도 자리를 지킨다 — low/high/max만 있는 모델에서 셋을 균등히 벌리면
 * high가 한가운데 서서, 실제로는 3/5 지점인 단을 절반이라고 말하게 된다.
 */
export function EffortTrack({
  row,
  value,
  onChange,
  onConfirmCurrent,
  autoLabel,
  ariaLabel,
  autoValueText,
  apexToggleLabel,
  className,
}: EffortTrackProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const ladder = useMemo(() => ladderRungs(row), [row]);
  const gatedRungs = useMemo(() => {
    const gated = new Set(row.gatedEfforts ?? []);
    return ladder.filter((id) => gated.has(id));
  }, [ladder, row]);
  const hasGate = gatedRungs.length > 0;
  const ordinaryRungs = useMemo(
    () => ladder.filter((id) => !gatedRungs.includes(id)),
    [gatedRungs, ladder],
  );
  const [apexOpen, setApexOpen] = useState(() => value !== null && gatedRungs.includes(value));
  const [burstKey, setBurstKey] = useState(0);
  const [burstLeft, setBurstLeft] = useState("50%");
  // 제스처 동안 React 커밋을 기다리지 않고 고른 단을 추적한다 — 같은 포인터 시퀀스에서
  // "다른 단으로 옮겼다"와 "처음부터 이 단을 다시 눌렀다"를 갈라야 한다.
  const liveIndexRef = useRef(0);
  // pointerId까지 묶어 두면 터치에서 두 번째 손가락(button===0)이 제스처를 덮어 쓰지 못한다.
  const gestureRef = useRef<{ readonly pointerId: number; readonly originIndex: number; dirty: boolean } | null>(null);

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current === null) return;
    clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  }, []);

  useEffect(() => clearCollapseTimer, [clearCollapseTimer]);

  useEffect(() => {
    if (value === null || !gatedRungs.includes(value)) return;
    clearCollapseTimer();
    setApexOpen(true);
  }, [clearCollapseTimer, gatedRungs, value]);

  const slots = useMemo<readonly EffortSlot[]>(() => {
    const byId = new Map<string, OperationLaunchVariantChip>((row.chips ?? []).map((chip) => [chip.id, chip]));
    const visibleRungs = apexOpen ? ladder : ordinaryRungs;
    const rungs = visibleRungs.map((id) => ({
      id,
      label: byId.get(id)?.label ?? id.toUpperCase(),
      selectable: byId.has(id),
    }));
    return [{ id: null, label: autoLabel, selectable: true }, ...rungs];
  }, [apexOpen, autoLabel, ladder, ordinaryRungs, row]);

  const last = slots.length - 1;
  const index = Math.max(0, slots.findIndex((slot) => slot.id === value));
  const current = slots[index]!;
  const isAuto = current.id === null;
  const isApex = value !== null && gatedRungs.includes(value);
  liveIndexRef.current = index;

  const nearestSelectable = useCallback((target: number): number => {
    const bounded = Math.max(0, Math.min(target, last));
    if (slots[bounded]?.selectable) return bounded;
    for (let step = 1; step <= slots.length; step += 1) {
      if (slots[bounded - step]?.selectable) return bounded - step;
      if (slots[bounded + step]?.selectable) return bounded + step;
    }
    return liveIndexRef.current;
  }, [last, slots]);

  const commit = useCallback((next: number) => {
    clearCollapseTimer();
    const slot = slots[next];
    const previous = slots[liveIndexRef.current];
    if (!slot || slot.id === previous?.id) return false;
    const entersApex = slot.id !== null
      && gatedRungs.includes(slot.id)
      && (previous?.id == null || !gatedRungs.includes(previous.id));
    liveIndexRef.current = next;
    if (entersApex) {
      const ratio = last === 0 ? 0 : next / last;
      setBurstLeft(`calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))`);
      setBurstKey((key) => key + 1);
    } else if (apexOpen && (slot.id === null || !gatedRungs.includes(slot.id))) {
      collapseTimerRef.current = setTimeout(() => {
        collapseTimerRef.current = null;
        setApexOpen(false);
      }, 600);
    }
    onChange(slot.id);
    return true;
  }, [apexOpen, clearCollapseTimer, gatedRungs, last, onChange, slots]);

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
    if (next === null) return;
    if (commit(next) && gestureRef.current) gestureRef.current.dirty = true;
  }, [commit, indexFromPointer]);

  const endGesture = useCallback((event: PointerEvent<HTMLDivElement>, { confirm }: { readonly confirm: boolean }) => {
    const gesture = gestureRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // 시작한 포인터만 끝낸다 — 다른 접촉의 up이 활성 제스처를 지우면 안 된다.
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (!confirm || gesture.dirty || !onConfirmCurrent) return;
    // 주버튼으로 트랙 안에서 손을 뗄 때만 확정한다 — 우클릭·가운데 클릭이나
    // 세로로 트랙 밖까지 끌어 뺀 해제는 값을 고르는 실수가 되지 않게 막는다.
    if (event.button !== 0) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (
      event.clientX < rect.left
      || event.clientX > rect.right
      || event.clientY < rect.top
      || event.clientY > rect.bottom
    ) {
      return;
    }
    const next = indexFromPointer(event.clientX);
    // 처음부터 고른 단을 다시 눌렀고, 그 사이 다른 단으로 옮기지 않았을 때만 확정한다.
    if (next === gesture.originIndex) onConfirmCurrent();
  }, [indexFromPointer, onConfirmCurrent]);

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
    if (event.key === "Enter" && onConfirmCurrent) {
      event.preventDefault();
      event.stopPropagation();
      onConfirmCurrent();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    // 트랙은 메뉴 안에 산다. 방향키가 위로 새면 메뉴가 항목 이동으로 받아 함께 움직인다.
    event.stopPropagation();
    commit(next);
  }, [commit, index, last, nearestSelectable, onConfirmCurrent, slots]);

  const ratio = last === 0 ? 0 : index / last;
  const seamRatio = ladder.length === 0 ? 0 : (ordinaryRungs.length + 0.5) / ladder.length;

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
        data-apex-open={hasGate && apexOpen ? true : undefined}
        data-apex={isApex ? true : undefined}
        data-at-max={hasGate ? (isApex ? true : undefined) : (index === last && !isAuto ? true : undefined)}
        // 자동은 사다리의 최소 단이 아니라 "사다리를 쓰지 않음"이다. 파선 테두리·빈 손잡이·채움 0이
        // 한 어휘로 그것을 말한다 — 채움이 조금이라도 남으면 맨 왼쪽 단을 고른 것으로 읽힌다.
        data-auto={isAuto ? true : undefined}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          // 주 접촉만 받는다. 터치 두 번째 손가락도 button===0이라 isPrimary·활성 제스처로 막는다.
          if (!event.isPrimary || event.button !== 0 || gestureRef.current) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          gestureRef.current = { pointerId: event.pointerId, originIndex: liveIndexRef.current, dirty: false };
          fromPointer(event);
        }}
        onPointerMove={(event) => {
          const next = indexFromPointer(event.clientX);
          if (next !== null) setPreviewIndex(next);
          const gesture = gestureRef.current;
          if (!gesture || gesture.pointerId !== event.pointerId) return;
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          fromPointer(event);
        }}
        onPointerUp={(event) => endGesture(event, { confirm: true })}
        onPointerLeave={() => setPreviewIndex(null)}
        onPointerCancel={(event) => endGesture(event, { confirm: false })}
      >
        {/* 자동은 폭 0이다. 손잡이 여백(EDGE)만큼이라도 남기면 트랙 왼쪽 끝에 brass 조각이 비쳐,
            비운 상태가 최소 강도를 고른 것처럼 보인다. */}
        <span
          className="effort-track-fill"
          style={{ width: isAuto ? 0 : `calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))` }}
          aria-hidden="true"
        />
        <span className="effort-track-stops" aria-hidden="true">
          {slots.map((slot, position) => {
            const gatedIndex = slot.id === null ? -1 : gatedRungs.indexOf(slot.id);
            return (
              <span
                key={slot.id ?? "auto"}
                className="effort-track-stop"
                style={{
                  left: last === 0 ? "50%" : `${(position / last) * 100}%`,
                  animationDelay: gatedIndex >= 0 ? `${(gatedIndex + 1) * 90}ms` : undefined,
                }}
                data-apex-rung={gatedIndex >= 0 ? true : undefined}
                data-filled={position <= index && !isAuto ? true : undefined}
                data-gap={slot.selectable ? undefined : true}
                data-previewed={position === previewIndex ? true : undefined}
              />
            );
          })}
        </span>
        {hasGate ? (
          <span
            className="effort-track-apex-seam"
            style={{ left: `calc(${EDGE}px + ${seamRatio} * (100% - ${EDGE * 2}px))` }}
            aria-hidden="true"
          />
        ) : null}
        {burstKey > 0 ? (
          <span
            key={burstKey}
            className="effort-track-apex-burst"
            style={{ left: burstLeft }}
            onAnimationEnd={() => setBurstKey(0)}
            aria-hidden="true"
          />
        ) : null}
        <span
          className="effort-track-knob"
          style={{ left: `calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))` }}
          data-auto={isAuto ? true : undefined}
          aria-hidden="true"
        />
      </div>
      {hasGate ? (
        <button
          type="button"
          className="effort-track-apex-toggle"
          aria-pressed={apexOpen}
          aria-label={apexToggleLabel}
          title={apexToggleLabel}
          onClick={() => {
            clearCollapseTimer();
            setApexOpen((open) => !open);
          }}
        >✦</button>
      ) : null}
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
