import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { OperationLaunchVariantChip, OperationLaunchVariantRow } from "@fleet-console/sdk/operations";

/** 트랙 좌우 안쪽 여백 — 손잡이 반지름과 같아야 양 끝 스톱에서 손잡이가 트랙을 넘지 않는다. */
const EDGE = 13;

interface EffortSlot {
  readonly id: string | null;
  readonly label: string;
  /** 이 자리를 고를 수 있는가. 모델이 내놓지 않은 단은 자리만 지키고 비어 있다. */
  readonly selectable: boolean;
  /** 평범한 레일 뒤 챔버에 사는 단인가. 스쳐 지나간 제스처가 닿아서는 안 되는 자리다. */
  readonly special: boolean;
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
   *
   * 챔버 안의 특수 강도는 이 경로를 절대 타지 않는다 — 비싼 모드는 고르는 것과 내보내는 것이
   * 갈려야 하고, 실행은 호스트가 이름을 밝힌 별도 행위로 맡는다.
   */
  readonly onConfirmCurrent?: () => void;
  /** 강도를 비운 상태를 트랙 맨 앞 자리로 노출한다. */
  readonly autoLabel: string;
  readonly ariaLabel: string;
  readonly autoValueText: string;
  /** 챔버를 여는 게이트에 붙는 이름. 무엇이 그 뒤에 있는지 이름이 다 말해야 한다. */
  readonly revealLabel?: string;
  /** 챔버가 열린 뒤 닫는 컨트롤의 이름. */
  readonly collapseLabel?: string;
  /** 챔버 안의 단이 왜 비싼지 한 줄로 밝히는 경고. 열렸을 때만 보인다. */
  readonly specialWarning?: string;
  /** 특수 강도 id → 이 모드가 무엇인지 밝히는 한 줄. 보조기술의 aria-valuetext에도 실린다. */
  readonly specialDescriptions?: Readonly<Record<string, string>>;
  readonly className?: string;
}

/**
 * 강도 사다리를 하나의 축으로 세운 트랙. 목록과 달리 축은 단들 사이의 거리까지 말하므로,
 * 모델이 내놓지 않은 단도 자리를 지킨다 — low/high/max만 있는 모델에서 셋을 균등히 벌리면
 * high가 한가운데 서서, 실제로는 3/5 지점인 단을 절반이라고 말하게 된다.
 *
 * 축의 꼬리(`effortExpansion`)는 레일 밖 챔버에 산다. 챔버 자리는 접혀 있을 때도 비워 두므로
 * 펼쳐도 평범한 단들의 좌표가 움직이지 않는다 — 축 전체가 다시 눈금을 그리면 방금 고른 값이
 * 옮겨 간 것처럼 읽힌다.
 */
export function EffortTrack({
  row,
  value,
  onChange,
  onConfirmCurrent,
  autoLabel,
  ariaLabel,
  autoValueText,
  revealLabel,
  collapseLabel,
  specialWarning,
  specialDescriptions,
  className,
}: EffortTrackProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // 좌표는 레일이 아니라 프레임에서 읽는다. 접힌 레일은 축의 일부만 덮으므로 그 폭으로 나누면
  // 같은 자리가 다른 단을 가리켜, 펼치는 순간 평범한 단들이 제자리에서 옮겨 간 것처럼 읽힌다.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const gateRef = useRef<HTMLButtonElement | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  // 제스처 동안 React 커밋을 기다리지 않고 고른 단을 추적한다 — 같은 포인터 시퀀스에서
  // "다른 단으로 옮겼다"와 "처음부터 이 단을 다시 눌렀다"를 갈라야 한다.
  const liveIndexRef = useRef(0);
  // pointerId까지 묶어 두면 터치에서 두 번째 손가락(button===0)이 제스처를 덮어 쓰지 못한다.
  const gestureRef = useRef<{ readonly pointerId: number; readonly originIndex: number; readonly epoch: number; dirty: boolean } | null>(null);
  // 펼침은 고를 수 있는 범위를 바꾼다. 그 경계를 넘어 살아남은 제스처는 방금 생긴 특수 단에
  // 손을 얹은 채 놓게 되므로, epoch을 올려 이전 제스처의 이동·해제를 모두 버린다.
  const epochRef = useRef(0);

  const slots = useMemo<readonly EffortSlot[]>(() => {
    const byId = new Map<string, OperationLaunchVariantChip>((row.chips ?? []).map((chip) => [chip.id, chip]));
    const specials = new Set(row.effortExpansion?.rungs ?? []);
    const rungs = ladderRungs(row).map((id) => ({
      id,
      label: byId.get(id)?.label ?? id.toUpperCase(),
      selectable: byId.has(id),
      special: specials.has(id),
    }));
    return [{ id: null, label: autoLabel, selectable: true, special: false }, ...rungs];
  }, [autoLabel, row]);

  const last = slots.length - 1;
  // 평범한 레일의 끝. 챔버가 없는 행에서는 축의 끝과 같다.
  const ordinaryLast = useMemo(() => {
    const firstSpecial = slots.findIndex((slot) => slot.special);
    return firstSpecial < 0 ? last : firstSpecial - 1;
  }, [last, slots]);
  const hasChamber = ordinaryLast < last;

  const index = Math.max(0, slots.findIndex((slot) => slot.id === value));
  const current = slots[index]!;
  const isAuto = current.id === null;
  const atSpecial = current.special;
  liveIndexRef.current = index;

  // 특수 단이 실려 있으면 챔버는 열린 채로 둔다. 접힌 레일이 비싼 모드를 숨기고 있으면 아무도
  // 고르지 않은 값으로 다음 실행이 나간다.
  const open = expanded || atSpecial;
  const activeLast = open ? last : ordinaryLast;

  // 접힌 동안 남겨 두는 평범한 폴백. 챔버를 닫을 때 특수 단을 이 값으로 되돌린다.
  const ordinaryFallbackRef = useRef<string | null>(null);
  useEffect(() => {
    if (!atSpecial) ordinaryFallbackRef.current = value;
  }, [atSpecial, value]);

  const nearestSelectable = useCallback((target: number): number => {
    const bounded = Math.max(0, Math.min(target, activeLast));
    if (slots[bounded]?.selectable) return bounded;
    for (let step = 1; step <= slots.length; step += 1) {
      if (bounded - step >= 0 && slots[bounded - step]?.selectable) return bounded - step;
      if (bounded + step <= activeLast && slots[bounded + step]?.selectable) return bounded + step;
    }
    return liveIndexRef.current;
  }, [activeLast, slots]);

  const commit = useCallback((next: number) => {
    const slot = slots[next];
    if (!slot || slot.id === slots[liveIndexRef.current]?.id) return false;
    liveIndexRef.current = next;
    onChange(slot.id);
    return true;
  }, [onChange, slots]);

  const indexFromPointer = useCallback((clientX: number): number | null => {
    const frame = frameRef.current;
    if (!frame || last === 0) return null;
    const rect = frame.getBoundingClientRect();
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
    // 펼침 경계를 넘어온 제스처는 값을 고르는 의사로 읽지 않는다.
    if (gesture.epoch !== epochRef.current) return;
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
    // 챔버 안의 단은 다시 눌러도 실행되지 않는다.
    if (next !== null && slots[next]?.special) return;
    // 처음부터 고른 단을 다시 눌렀고, 그 사이 다른 단으로 옮기지 않았을 때만 확정한다.
    if (next === gesture.originIndex) onConfirmCurrent();
  }, [indexFromPointer, onConfirmCurrent, slots]);

  /** 펼침·접힘은 제스처 경계다. 붙잡고 있던 포인터를 여기서 끊어야 방금 생긴 단에 착지하지 않는다. */
  const breakGesture = useCallback(() => {
    epochRef.current += 1;
    gestureRef.current = null;
    setPreviewIndex(null);
  }, []);

  // 게이트를 누르면 그 게이트가 사라진다. 초점을 옮겨 두지 않으면 body로 떨어져, 키보드로 온
  // 사람이 방금 연 챔버 앞에서 조작할 대상을 잃는다. 버튼이 실제로 붙은 뒤에 옮겨야 하므로
  // 의사만 남기고 커밋 이후에 처리한다.
  const focusIntentRef = useRef<"rail" | "gate" | null>(null);
  useEffect(() => {
    const intent = focusIntentRef.current;
    if (intent === null) return;
    focusIntentRef.current = null;
    if (intent === "rail") trackRef.current?.focus();
    else gateRef.current?.focus();
  }, [open]);

  const openChamber = useCallback(() => {
    breakGesture();
    focusIntentRef.current = "rail";
    setExpanded(true);
  }, [breakGesture]);

  const closeChamber = useCallback(() => {
    breakGesture();
    focusIntentRef.current = "gate";
    setExpanded(false);
    // 특수 단이 실린 채로는 접을 수 없다. 챔버를 닫는 것은 그 모드를 내려놓는 일이다.
    if (atSpecial) onChange(ordinaryFallbackRef.current);
  }, [atSpecial, breakGesture, onChange]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" || event.key === "ArrowDown"
      ? -1
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : 0;
    let next: number | null = null;
    // 방향키는 그 방향으로 고를 수 있는 다음 단까지 건너뛴다 — 비어 있는 자리에 멈추지 않는다.
    if (direction !== 0) {
      for (let i = index + direction; i >= 0 && i <= activeLast; i += direction) {
        if (slots[i]!.selectable) { next = i; break; }
      }
      // 접힌 천장에서 더 오른쪽으로 가려는 키는 게이트로 초점을 넘긴다. 챔버를 열어 주지는
      // 않는다 — 방향키가 비싼 모드를 여는 손잡이가 되면 그 문은 문이 아니다.
      if (next === null && direction === 1 && !open && hasChamber) {
        event.preventDefault();
        event.stopPropagation();
        gateRef.current?.focus();
        return;
      }
    }
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = nearestSelectable(activeLast);
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeChamber();
      return;
    }
    if (event.key === "Enter" && onConfirmCurrent) {
      // 눌린 채 반복되는 Enter는 확정 의사가 아니다.
      if (event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      // 챔버 안의 단은 장전까지만이다 — 실행은 이름을 밝힌 별도 행위가 맡는다.
      if (atSpecial) return;
      onConfirmCurrent();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    // 트랙은 메뉴 안에 산다. 방향키가 위로 새면 메뉴가 항목 이동으로 받아 함께 움직인다.
    event.stopPropagation();
    commit(next);
  }, [activeLast, atSpecial, closeChamber, commit, hasChamber, index, nearestSelectable, onConfirmCurrent, open, slots]);

  const ratio = last === 0 ? 0 : index / last;
  // 레일이 덮는 길이. 접혀 있으면 평범한 천장에서 끊기고, 남은 폭이 챔버다.
  const laneRatio = last === 0 ? 1 : activeLast / last;
  const laneWidth = open ? "100%" : `calc(${EDGE * 2}px + ${laneRatio} * (100% - ${EDGE * 2}px))`;
  const specialDescription = current.id === null ? undefined : specialDescriptions?.[current.id];

  return (
    <div className={`effort-track-shell${className ? ` ${className}` : ""}`} data-open={open ? true : undefined}>
      {/* 채움·스톱·손잡이는 레일이 아니라 이 상자를 기준으로 자리를 잰다 — 레일이 챔버로 자라도
          이미 고른 단이 제자리에 남아야 하므로 레일의 자식으로 둘 수 없다. 상태는 그대로 레일이
          지고, 형제 선택자로 이 안의 조각들에 닿는다. */}
      <div className="effort-track-frame" ref={frameRef}>
        <div
          ref={trackRef}
          className="effort-track"
          role="slider"
          tabIndex={0}
          aria-label={ariaLabel}
          aria-valuemin={0}
          aria-valuemax={activeLast}
          aria-valuenow={index}
          aria-valuetext={isAuto ? autoValueText : specialDescription ?? current.label}
          // 자동은 사다리의 최소 단이 아니라 "사다리를 쓰지 않음"이다. 파선 테두리·빈 손잡이·채움 0이
          // 한 어휘로 그것을 말한다 — 채움이 조금이라도 남으면 맨 왼쪽 단을 고른 것으로 읽힌다.
          data-auto={isAuto ? true : undefined}
          // 최고 단 텍스처는 축의 끝이 아니라 지금 고를 수 있는 천장을 말한다. 축의 끝자리로 읽으면
          // 챔버가 열려 있을 때만 켜져, 접힌 레일의 천장이 천장으로 보이지 않는다.
          data-at-max={index === activeLast && !isAuto ? true : undefined}
          data-special={atSpecial ? current.id : undefined}
          style={{ width: laneWidth }}
          onKeyDown={handleKeyDown}
          onPointerDown={(event) => {
            // 주 접촉만 받는다. 터치 두 번째 손가락도 button===0이라 isPrimary·활성 제스처로 막는다.
            if (!event.isPrimary || event.button !== 0 || gestureRef.current) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.focus();
            gestureRef.current = { pointerId: event.pointerId, originIndex: liveIndexRef.current, epoch: epochRef.current, dirty: false };
            fromPointer(event);
          }}
          onPointerMove={(event) => {
            const next = indexFromPointer(event.clientX);
            if (next !== null) setPreviewIndex(next);
            const gesture = gestureRef.current;
            if (!gesture || gesture.pointerId !== event.pointerId) return;
            if (gesture.epoch !== epochRef.current) return;
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            fromPointer(event);
          }}
          onPointerUp={(event) => endGesture(event, { confirm: true })}
          onPointerLeave={() => setPreviewIndex(null)}
          onPointerCancel={(event) => endGesture(event, { confirm: false })}
        />
        {/* 자동은 폭 0이다. 손잡이 여백(EDGE)만큼이라도 남기면 트랙 왼쪽 끝에 brass 조각이 비쳐,
            비운 상태가 최소 강도를 고른 것처럼 보인다. 고른 단이 레일 끝을 넘지 못하므로 이 채움은
            레일 밖으로 새지 않는다 — 잘라내지 않아도 된다. */}
        <span
          className="effort-track-fill"
          style={{ width: isAuto ? 0 : `calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))` }}
          aria-hidden="true"
        />
        {/* 챔버가 열릴 때 한 번만 지나가는 빛. 열림에 매달아 두면 상시 루프가 되지 않는다 —
            계속 움직이는 표면은 값이 아직 정해지지 않았다고 말한다. */}
        {open ? <span className="effort-track-reveal-sheen" aria-hidden="true" /> : null}
        <span className="effort-track-stops" aria-hidden="true">
          {slots.map((slot, position) => (
            position <= activeLast ? (
              <span
                key={slot.id ?? "auto"}
                className="effort-track-stop"
                style={{ left: last === 0 ? "50%" : `calc(${EDGE}px + ${position / last} * (100% - ${EDGE * 2}px))` }}
                data-filled={position <= index && !isAuto ? true : undefined}
                data-gap={slot.selectable ? undefined : true}
                data-special={slot.special ? slot.id : undefined}
                data-previewed={position === previewIndex ? true : undefined}
              />
            ) : null
          ))}
        </span>
        <span
          className="effort-track-knob"
          style={{ left: `calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))` }}
          data-auto={isAuto ? true : undefined}
          data-special={atSpecial ? current.id : undefined}
          aria-hidden="true"
        />
        {hasChamber && !open ? (
          <button
            ref={gateRef}
            type="button"
            className="effort-track-gate"
            style={{ left: `calc(${EDGE * 2}px + ${laneRatio} * (100% - ${EDGE * 2}px))` }}
            aria-expanded={false}
            aria-label={revealLabel}
            title={revealLabel}
            onClick={openChamber}
          >
            <span className="effort-track-gate-leaf" aria-hidden="true" />
            <span className="effort-track-gate-leaf" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {/* 단계 톤은 CSS가 이 속성 하나로 읽는다 — 라벨 문자열은 번역·모델마다 달라 색의 기준이 될 수 없다. */}
      <span className="effort-track-value" data-auto={isAuto} data-effort-level={current.id ?? "auto"}>
        {current.label}
      </span>
      {/* 비싼 모드가 열려 있는 동안에는 왜 비싼지 화면에도 남는다 — 게이트를 지난 뒤에 사라지면
          고르는 순간에는 아무 말도 하지 않는 경고가 된다. 닫는 손잡이도 여기 함께 띄운다: 트랙
          옆에 흐름대로 놓으면 열릴 때마다 프레임이 그만큼 좁아져, 움직이지 않아야 할 평범한
          단들이 제자리에서 밀린다. */}
      {hasChamber && open ? (
        <div className="effort-track-chamber-note">
          {specialWarning ? <span role="status">{specialWarning}</span> : null}
          <button
            ref={gateRef}
            type="button"
            className="effort-track-collapse"
            aria-expanded
            aria-label={collapseLabel}
            title={collapseLabel}
            onClick={closeChamber}
          >
            <span aria-hidden="true">‹</span>
          </button>
        </div>
      ) : null}
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
 *
 * 눈금은 평범한 레일까지만 센다. 챔버 안의 단을 막대 하나로 더 얹으면 "여섯 칸이니 더 깊다"는
 * 거짓을 그리게 되는데, ultracode는 xhigh 깊이에 오케스트레이션을 얹은 모드다. 그래서 특수 단은
 * 칸이 아니라 별도 표식으로 나간다.
 */
export function effortLadderPosition(row: OperationLaunchVariantRow, effort: string | null): {
  readonly rung: number;
  readonly total: number;
  readonly special: string | null;
} {
  const rungs = ladderRungs(row);
  const specials = new Set(row.effortExpansion?.rungs ?? []);
  const ordinary = rungs.filter((id) => !specials.has(id));
  if (effort !== null && specials.has(effort)) {
    return { rung: ordinary.length, total: ordinary.length, special: effort };
  }
  return {
    rung: effort === null ? 0 : ordinary.indexOf(effort) + 1,
    total: ordinary.length,
    special: null,
  };
}

/**
 * 기억해 둔 강도가 이 모델 사다리에 없으면 비운 상태로 떨어진다.
 *
 * 챔버 뒤의 특수 단은 사다리에 있어도 물려받지 않는다. 챔버가 있는 이유가 "그 값은 스쳐서
 * 닿을 수 없어야 한다"인데, 디스크나 직전 모델에서 실려 오는 값은 정의상 고른 것이 아니다.
 */
export function resolveRowEffort(row: OperationLaunchVariantRow | null, effort: string | null): string | null {
  if (!row || effort === null) return null;
  if (isSpecialEffort(row, effort)) return null;
  return row.chips?.some((chip) => chip.id === effort) ? effort : null;
}

/** 이 강도가 챔버 뒤의 특수 모드인가. 저장·복원 경계가 이 판정을 공유해야 한다. */
export function isSpecialEffort(row: OperationLaunchVariantRow | null, effort: string | null): boolean {
  if (!row || effort === null) return false;
  return (row.effortExpansion?.rungs ?? []).includes(effort);
}
