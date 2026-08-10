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
   *
   * 챔버 안의 특수 강도는 이 경로를 절대 타지 않는다 — 비싼 모드는 고르는 것과 내보내는 것이
   * 갈려야 하고, 실행은 호스트가 이름을 밝힌 별도 행위로 맡는다.
   */
  readonly onConfirmCurrent?: () => void;
  /** 강도를 비운 상태를 트랙 맨 앞 자리로 노출한다. */
  readonly autoLabel: string;
  readonly ariaLabel: string;
  readonly autoValueText: string;
  /** 챔버를 여닫는 게이트에 붙는 이름. 무엇이 그 뒤에 있는지 이름이 다 말해야 한다. */
  readonly revealLabel?: string;
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
 * 축의 꼬리(`effortExpansion`)는 레일에 실리지 않는다. 비싼 모드를 눈금 한두 칸으로 더 얹으면
 * 같은 폭에 단만 늘어 간격이 좁아지고, 손잡이가 이웃 단을 덮어 스쳐도 닿는 자리가 된다 —
 * 게이트를 둔 이유와 정반대다. 레일은 언제나 평범한 천장에서 끝나고, 그 뒤는 흐름 안에 펼쳐지는
 * 별도의 면(챔버)이 맡는다.
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
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  // 제스처 동안 React 커밋을 기다리지 않고 고른 단을 추적한다 — 같은 포인터 시퀀스에서
  // "다른 단으로 옮겼다"와 "처음부터 이 단을 다시 눌렀다"를 갈라야 한다.
  const liveIndexRef = useRef(0);
  // pointerId까지 묶어 두면 터치에서 두 번째 손가락(button===0)이 제스처를 덮어 쓰지 못한다.
  const gestureRef = useRef<{ readonly pointerId: number; readonly originIndex: number; dirty: boolean } | null>(null);

  const chips = useMemo(
    () => new Map<string, OperationLaunchVariantChip>((row.chips ?? []).map((chip) => [chip.id, chip])),
    [row],
  );

  const slots = useMemo<readonly EffortSlot[]>(() => {
    const rungs = ladderRungs(row).map((id) => ({
      id,
      label: chips.get(id)?.label ?? id.toUpperCase(),
      selectable: chips.has(id),
    }));
    return [{ id: null, label: autoLabel, selectable: true }, ...rungs];
  }, [autoLabel, chips, row]);

  /**
   * 레일의 끝. 경계는 `rungs`가 아니라 `after`가 정한다 — `rungs`는 이 모델이 실제로 내주는
   * 챔버 단만 담으므로, xhigh까지만 내주는 모델(`{after:"xhigh", rungs:["ultracode"]}`)에서
   * `rungs`로 경계를 잡으면 축에 남아 있는 MAX가 평범한 빈 단으로 레일에 실려, 게이트가 서기도
   * 전에 레일이 천장을 넘어간다.
   */
  const ordinaryLast = useMemo(() => {
    const after = row.effortExpansion?.after;
    if (after === undefined) return slots.length - 1;
    const boundary = slots.findIndex((slot) => slot.id === after);
    return boundary < 0 ? slots.length - 1 : boundary;
  }, [row, slots]);

  /** 챔버가 맡는 자리. 축에는 있지만 이 모델이 내주지 않는 단도 자리를 지킨다. */
  const chamberSlots = useMemo(() => {
    const offered = new Set(row.effortExpansion?.rungs ?? []);
    return slots.slice(ordinaryLast + 1).map((slot) => ({
      ...slot,
      selectable: slot.selectable && slot.id !== null && offered.has(slot.id),
    }));
  }, [ordinaryLast, row, slots]);
  const hasChamber = chamberSlots.length > 0;

  const armed = chamberSlots.find((slot) => slot.id === value) ?? null;
  const atSpecial = armed !== null;
  // 특수 강도가 실려 있으면 레일은 천장을 가리킨다 — 축 밖의 값이므로 눈금으로는 말할 수 없고,
  // 무엇이 실렸는지는 값 라벨과 aria-valuetext가 맡는다.
  const index = atSpecial ? ordinaryLast : Math.max(0, slots.findIndex((slot) => slot.id === value));
  const current = atSpecial ? armed! : slots[index]!;
  const isAuto = !atSpecial && current.id === null;
  liveIndexRef.current = index;

  // 특수 단이 실려 있으면 챔버는 열린 채로 둔다. 접힌 면이 비싼 모드를 숨기고 있으면 아무도
  // 고르지 않은 값으로 다음 실행이 나간다.
  const open = expanded || atSpecial;

  // 접힌 동안 남겨 두는 평범한 폴백. 챔버를 닫거나 장전을 풀 때 이 값으로 되돌린다.
  const ordinaryFallbackRef = useRef<string | null>(null);
  useEffect(() => {
    if (!atSpecial) ordinaryFallbackRef.current = value;
  }, [atSpecial, value]);

  const nearestSelectable = useCallback((target: number): number => {
    const bounded = Math.max(0, Math.min(target, ordinaryLast));
    if (slots[bounded]?.selectable) return bounded;
    for (let step = 1; step <= slots.length; step += 1) {
      if (bounded - step >= 0 && slots[bounded - step]?.selectable) return bounded - step;
      if (bounded + step <= ordinaryLast && slots[bounded + step]?.selectable) return bounded + step;
    }
    return liveIndexRef.current;
  }, [ordinaryLast, slots]);

  const commit = useCallback((next: number) => {
    const slot = slots[next];
    if (!slot) return false;
    // 특수 강도가 실린 채 레일을 만지는 것은 그 모드를 내려놓는 일이다 — 같은 id로 보여도
    // 지금 실린 값은 축 밖에 있으므로 "이미 고른 단"이 아니다.
    if (!atSpecial && slot.id === slots[liveIndexRef.current]?.id) return false;
    liveIndexRef.current = next;
    onChange(slot.id);
    return true;
  }, [atSpecial, onChange, slots]);

  const indexFromPointer = useCallback((clientX: number): number | null => {
    const frame = frameRef.current;
    if (!frame || ordinaryLast === 0) return null;
    const rect = frame.getBoundingClientRect();
    const span = rect.width - EDGE * 2;
    if (span <= 0) return null;
    const ratio = Math.max(0, Math.min((clientX - rect.left - EDGE) / span, 1));
    return nearestSelectable(Math.round(ratio * ordinaryLast));
  }, [nearestSelectable, ordinaryLast]);

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
    // 처음부터 고른 단을 다시 눌렀고, 그 사이 다른 단으로 옮기지 않았을 때만 확정한다.
    if (indexFromPointer(event.clientX) === gesture.originIndex) onConfirmCurrent();
  }, [indexFromPointer, onConfirmCurrent]);

  /** 챔버를 닫는 것은 장전을 푸는 일이다 — 접힌 면 뒤에 비싼 모드가 남아 있으면 안 된다. */
  const closeChamber = useCallback(() => {
    setExpanded(false);
    if (atSpecial) onChange(ordinaryFallbackRef.current);
  }, [atSpecial, onChange]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" || event.key === "ArrowDown"
      ? -1
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : 0;
    let next: number | null = null;
    // 방향키는 그 방향으로 고를 수 있는 다음 단까지 건너뛴다 — 비어 있는 자리에 멈추지 않는다.
    if (direction !== 0) {
      for (let i = index + direction; i >= 0 && i <= ordinaryLast; i += direction) {
        if (slots[i]!.selectable) { next = i; break; }
      }
    }
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = nearestSelectable(ordinaryLast);
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
  }, [atSpecial, closeChamber, commit, index, nearestSelectable, onConfirmCurrent, open, ordinaryLast, slots]);

  const ratio = ordinaryLast === 0 ? 0 : index / ordinaryLast;
  const specialDescription = armed?.id === undefined || armed?.id === null ? undefined : specialDescriptions?.[armed.id];

  return (
    <div className={`effort-track-shell${className ? ` ${className}` : ""}`} data-open={open ? true : undefined}>
      {/* 레일 행의 구성은 상태와 무관하게 고정이다 — 게이트가 붙었다 떨어지면 레일이 그만큼
          넓어졌다 좁아져, 움직이지 않아야 할 단들이 제자리에서 밀린다. */}
      <div className="effort-track-row">
        {/* 채움·스톱·손잡이는 레일이 아니라 이 상자를 기준으로 자리를 잰다. 상태는 그대로 레일이
            지고, 형제 선택자로 이 안의 조각들에 닿는다. */}
        <div className="effort-track-frame" ref={frameRef}>
          <div
            ref={trackRef}
            className="effort-track"
            role="slider"
            tabIndex={0}
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={ordinaryLast}
            aria-valuenow={index}
            aria-valuetext={isAuto ? autoValueText : specialDescription ?? current.label}
            // 자동은 사다리의 최소 단이 아니라 "사다리를 쓰지 않음"이다. 파선 테두리·빈 손잡이·채움 0이
            // 한 어휘로 그것을 말한다 — 채움이 조금이라도 남으면 맨 왼쪽 단을 고른 것으로 읽힌다.
            data-auto={isAuto ? true : undefined}
            data-at-max={index === ordinaryLast && !isAuto && !atSpecial ? true : undefined}
            data-special={armed?.id ?? undefined}
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
          />
          {/* 자동은 폭 0이다. 손잡이 여백(EDGE)만큼이라도 남기면 트랙 왼쪽 끝에 brass 조각이 비쳐,
              비운 상태가 최소 강도를 고른 것처럼 보인다. 특수 강도는 축 밖이므로 레일을 끝까지 채운다. */}
          <span
            className="effort-track-fill"
            style={{ width: isAuto ? 0 : atSpecial ? "auto" : `calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))` }}
            data-flood={atSpecial ? true : undefined}
            aria-hidden="true"
          />
          <span className="effort-track-stops" aria-hidden="true">
            {slots.map((slot, position) => (
              position <= ordinaryLast ? (
                <span
                  key={slot.id ?? "auto"}
                  className="effort-track-stop"
                  style={{ left: ordinaryLast === 0 ? "50%" : `calc(${EDGE}px + ${position / ordinaryLast} * (100% - ${EDGE * 2}px))` }}
                  data-filled={(position <= index && !isAuto) || atSpecial ? true : undefined}
                  data-gap={slot.selectable ? undefined : true}
                  data-previewed={position === previewIndex ? true : undefined}
                />
              ) : null
            ))}
          </span>
          <span
            className="effort-track-knob"
            style={{ left: `calc(${EDGE}px + ${ratio} * (100% - ${EDGE * 2}px))` }}
            data-auto={isAuto ? true : undefined}
            data-special={armed?.id ?? undefined}
            aria-hidden="true"
          />
        </div>
        {/* 단계 톤은 CSS가 이 속성 하나로 읽는다 — 라벨 문자열은 번역·모델마다 달라 색의 기준이 될 수 없다. */}
        <span className="effort-track-value" data-auto={isAuto} data-effort-level={current.id ?? "auto"}>
          {current.label}
        </span>
        {hasChamber ? (
          <button
            type="button"
            className="effort-track-gate"
            aria-expanded={open}
            aria-label={open ? collapseLabel : revealLabel}
            title={open ? collapseLabel : revealLabel}
            data-armed={atSpecial ? true : undefined}
            onClick={() => (open ? closeChamber() : setExpanded(true))}
          >
            <span className="effort-track-gate-leaf" aria-hidden="true" />
            <span className="effort-track-gate-leaf" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {/* 챔버는 흐름 안에 펼쳐진다. 레일 위로 띄우면 플라이아웃의 overflow가 잘라 내 — 비용을
          밝히겠다고 만든 면이 정작 화면에 없다. */}
      {hasChamber && open ? (
        <div className="effort-track-chamber" role="group" aria-label={revealLabel}>
          {specialWarning ? <p className="effort-track-chamber-warning">{specialWarning}</p> : null}
          <div className="effort-track-chamber-tiles">
            {chamberSlots.map((slot) => (
              <button
                key={slot.id ?? "chamber"}
                type="button"
                className="effort-track-chamber-tile"
                data-effort-level={slot.id ?? undefined}
                // 고르는 것과 내보내는 것을 가른다. 눌린 타일은 장전이지 실행이 아니므로
                // 상태는 pressed로 말하고, 다시 누르면 장전을 푼다.
                aria-pressed={slot.id === value}
                disabled={!slot.selectable}
                onClick={() => onChange(slot.id === value ? ordinaryFallbackRef.current : slot.id)}
              >
                <span className="effort-track-chamber-tile-name">{slot.label}</span>
                {slot.id !== null && specialDescriptions?.[slot.id] ? (
                  <span className="effort-track-chamber-tile-note">
                    {stripLabelPrefix(specialDescriptions[slot.id]!, slot.label)}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 설명 문장은 보조기술이 단 이름 없이 듣는 자리(aria-valuetext)를 겸하므로 "MAX — …" 꼴로 이름을
 * 앞에 달고 있다. 이름이 이미 제목으로 선 타일에서는 그 앞머리를 걷어 낸다.
 */
function stripLabelPrefix(description: string, label: string): string {
  const prefix = `${label} — `;
  return description.startsWith(prefix) ? description.slice(prefix.length) : description;
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
 * 챔버가 맡는 단들. 경계는 `after`가 정하고 `rungs`는 그중 무엇을 실제로 내주는지만 고른다 —
 * 저장·복원 경계가 `rungs`만 보면, 모델이 내주지 않아 축에만 남은 단이 평범한 단으로 새어 나간다.
 */
function chamberRungs(row: OperationLaunchVariantRow): readonly string[] {
  const after = row.effortExpansion?.after;
  if (after === undefined) return [];
  const rungs = ladderRungs(row);
  const boundary = rungs.indexOf(after);
  return boundary < 0 ? [] : rungs.slice(boundary + 1);
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
  const specials = new Set(chamberRungs(row));
  const ordinary = ladderRungs(row).filter((id) => !specials.has(id));
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
  return chamberRungs(row).includes(effort);
}
