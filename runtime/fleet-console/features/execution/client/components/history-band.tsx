import React from "react";

/**
 * History band — 로그 맨 위에 서서 접힌 이전 대화을 대신 말하는 한 줄.
 *
 * 대화 로그는 마지막 대화만 보여 준다. 새 답이 오면 그 질문이 로그 상단에 앉고, 앞선 대화는 이
 * 밴드 뒤로 물러난다. 누르거나(키보드 Enter·Space) 로그 맨 위에서 위로 한 번 더 굴리면 펼쳐지고,
 * 펼친 뒤에도 문서 순서는 시간순이라 보조 기술은 위에서 아래로 그대로 읽는다.
 *
 * 스크롤 컨테이너의 첫 자식으로, 흐름 안에 선다 — 면도 배경도 없는 헤어라인 한 줄이라 어느 테마의
 * 어느 표면 위에서도 이질감이 없다.
 */
export interface HistoryBandProps {
  /** 접힌 문답 수. 0이면 밴드가 서지 않는다. */
  readonly count: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** 눈에 보이는 문구("이전 대화 2 · 펼치기"). 상태에 맞는 문구를 호출자가 고른다. */
  readonly label: string;
  readonly className?: string;
}

export function HistoryBand({ count, open, onToggle, label, className }: HistoryBandProps) {
  if (count <= 0) return null;
  return (
    <div
      className={`fc-history-band${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onToggle();
      }}
    >
      <span className="fc-history-band__label">{label}</span>
    </div>
  );
}

/**
 * 로그 맨 위에서 위로 한 번 더 굴리면 이전 대화이 펼쳐진다.
 *
 * 첫 번째 굴림은 "맨 위에 닿았다"는 신호이고 두 번째가 의도다 — 한 번에 펼치면 긴 답을 훑어
 * 올라오는 관성이 곧바로 지난 문답을 쏟아낸다. 두 굴림 사이가 길면 무장을 푼다.
 */
export function useHistoryReveal({ ref, armed, onReveal, windowMs = 600 }: {
  readonly ref: React.RefObject<HTMLElement | null>;
  /** 펼칠 것이 있고 아직 접혀 있을 때만 참. */
  readonly armed: boolean;
  readonly onReveal: () => void;
  readonly windowMs?: number;
}): void {
  const nudgedAt = React.useRef<number | null>(null);
  React.useEffect(() => {
    const element = ref.current;
    if (!element || !armed) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0 || element.scrollTop > 0) { nudgedAt.current = null; return; }
      const now = Date.now();
      if (nudgedAt.current !== null && now - nudgedAt.current <= windowMs) {
        nudgedAt.current = null;
        onReveal();
        return;
      }
      nudgedAt.current = now;
    };
    element.addEventListener("wheel", onWheel, { passive: true });
    return () => element.removeEventListener("wheel", onWheel);
  }, [ref, armed, onReveal, windowMs]);
}
