import type { CSSProperties } from "react";

/** 트랙과 같은 픽셀 앵커 — 두 표식이 나란히 서는 화면에서 축의 길이가 어긋나면 안 된다. */
const EDGE = 13;
const CLOSED_TRACK_WIDTH = 116;
const TRACK_CHROME = EDGE * 2 + 2;

export interface EffortReadoutProps {
  /** 강도 사다리의 단들, 낮은 쪽부터. 자동은 이 목록 앞의 자리로 따로 선다. */
  readonly rungs: readonly string[];
  /** 이 세션의 단. 사다리에 없는 값(또는 `null`)은 자동으로 읽는다. */
  readonly value: string | null;
  readonly ariaLabel: string;
  readonly className?: string;
}

/**
 * 강도를 **읽기만** 하는 계기. 트랙과 같은 축·같은 채움·같은 티어 연출을 쓰되, 손잡이 대신
 * 지침이 선다.
 *
 * 손잡이를 그대로 두지 않는 이유가 이 컴포넌트의 존재 이유다: 이 앱에서 20px 흰 원은 "끌 수
 * 있다"는 어휘이고, 세션 좌표는 여기서 바꿀 수 없다 — 바꾸는 길은 새 세션을 여는 것뿐이다.
 * 누를 수 있게 그리면 거짓 약속이 되므로, 만질 수 있다는 신호만 걷고 축이 말하던 사실
 * (사다리 어디쯤인가, 게이트 뒤 티어인가)은 그대로 남긴다.
 */
export function EffortReadout({ rungs, value, ariaLabel, className }: EffortReadoutProps) {
  // 자동은 사다리의 최소 단이 아니라 사다리를 쓰지 않는 상태다 — 트랙과 같이 맨 앞자리를 준다.
  const index = value === null ? 0 : rungs.indexOf(value) + 1;
  const isAuto = index <= 0;
  const last = rungs.length;
  const closedIntervals = Math.max(last, 1);
  const position = isAuto ? 0 : index;
  const left = `calc(${EDGE}px + var(--effort-track-gap) * ${position})`;
  const level = isAuto ? "auto" : rungs[index - 1];
  // apex 티어(게이트 뒤 단들)는 사다리의 마지막 둘이다 — 트랙이 crest·apex로 가르는 것과 같은 자리.
  const apex = !isAuto && index >= last - 1;

  return (
    <span className={`effort-track-shell${className ? ` ${className}` : ""}`}>
      <span
        className="effort-track"
        data-readonly="true"
        role="img"
        aria-label={ariaLabel}
        data-apex={apex ? true : undefined}
        data-at-max={!isAuto && index === last ? true : undefined}
        data-auto={isAuto ? true : undefined}
        data-effort-level={level}
        style={{
          "--effort-intervals": Math.max(last, 1),
          "--effort-closed-intervals": closedIntervals,
        } as CSSProperties}
      >
        <span className="effort-track-fill" style={{ width: isAuto ? 0 : left }} aria-hidden="true" />
        <span className="effort-track-stops" aria-hidden="true">
          {Array.from({ length: last + 1 }, (_unused, slot) => (
            <span
              key={slot}
              className="effort-track-stop"
              style={{ left: `calc(var(--effort-track-gap) * ${slot})` }}
              data-filled={!isAuto && slot <= index ? true : undefined}
            />
          ))}
          {isAuto ? null : <span className="effort-track-needle" style={{ left }} aria-hidden="true" />}
        </span>
      </span>
    </span>
  );
}

/** 트랙 폭 산술이 CSS와 어긋나지 않는지 테스트가 집는 값. */
export const EFFORT_READOUT_TRACK_METRICS = { EDGE, CLOSED_TRACK_WIDTH, TRACK_CHROME } as const;
