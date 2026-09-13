import React from "react";

/**
 * Live line — 도는 턴의 "지금" 한 줄.
 *
 * 채팅뷰의 라이브 집계 줄이 세운 문법을 한 부품으로 옮긴 것이다: aurora 링 하나, 물결치는 문구
 * 하나, 오른쪽 끝의 경과·집계 하나. 줄은 제자리에서 갱신되고 세로로 자라지 않는다 — 도구 행이
 * 쌓이면 문장이 밀려나고, 끝난 뒤 접힘을 펼치면 어차피 전체가 나온다. 이 줄이 말하는 것은 "지금
 * 무엇을 하는가"뿐이며, 과정의 역사는 {@link LiveFold}가 맡는다.
 *
 * 라이브 리전은 이 줄 하나다(`role="status"`). 생각의 점은 장식이라 낭독되지 않는다.
 */
export interface LiveLineProps {
  /** 지금 도는 것 — 동사와 대상이 한 문구로 온다("읽는 중 · github.com/…"). */
  readonly label: string;
  /** 도는 도구가 없는 공백 — 문구 뒤에 점 세 개가 하나씩 켜진다. */
  readonly thinking?: boolean;
  /** 오른쪽 끝의 집계·경과("2스텝 · 6s"). 없으면 비운다. */
  readonly meta?: string;
  readonly stopLabel?: string;
  readonly onStop?: () => void;
  readonly className?: string;
}

export function LiveLine({ label, thinking = false, meta, stopLabel, onStop, className }: LiveLineProps) {
  return (
    <div className={`fc-live-line${className ? ` ${className}` : ""}`} role="status" aria-live="polite">
      <span className="fc-live-line__orbit" aria-hidden="true" />
      <span className="fc-live-line__text">
        <span className="fc-live-line__sweep">{label}</span>
        {thinking ? (
          <span className="fc-live-line__dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
        ) : null}
      </span>
      {meta ? <span className="fc-live-line__meta">{meta}</span> : null}
      {onStop && stopLabel ? (
        <button type="button" className="fc-live-line__stop" onClick={onStop}>{stopLabel}</button>
      ) : null}
    </div>
  );
}

/**
 * 끝난 턴의 과정이 가라앉는 한 줄("3스텝 · 9s ⌄"). 펼칠 것이 있으면 `<details>`이고, 없으면
 * 눌리는 척하지 않는 평범한 줄이다 — 열쇠 없는 자물쇠는 어포던스가 아니라 거짓말이다.
 */
export interface LiveFoldProps {
  readonly summary: string;
  /** 펼침 손잡이의 보조 기술 이름("이 응답의 작업 과정 보기"). */
  readonly ariaLabel?: string;
  readonly tone?: "done" | "stopped" | "error";
  readonly className?: string;
  readonly children?: React.ReactNode;
}

export function LiveFold({ summary, ariaLabel, tone = "done", className, children }: LiveFoldProps) {
  const base = `fc-live-fold is-${tone}${className ? ` ${className}` : ""}`;
  if (!children) {
    return <div className={`${base} is-flat`}><span className="fc-live-fold__summary">{summary}</span></div>;
  }
  return (
    <details className={base}>
      <summary className="fc-live-fold__summary" aria-label={ariaLabel}>
        <span>{summary}</span>
        <span className="fc-live-fold__chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="fc-live-fold__body">{children}</div>
    </details>
  );
}

/** 접힘 안의 스텝 한 줄 — 완료(✓)·실패(✕)·진행(링) 표식과 문구. */
export interface LiveStepProps {
  readonly mark: "done" | "fail" | "running";
  readonly label: string;
  readonly detail?: string;
}

export function LiveStep({ mark, label, detail }: LiveStepProps) {
  return (
    <div className={`fc-live-step is-${mark}`}>
      {mark === "running"
        ? <span className="fc-live-line__orbit" aria-hidden="true" />
        : <span className="fc-live-step__mark" aria-hidden="true">{mark === "fail" ? "✕" : "✓"}</span>}
      <span className="fc-live-step__label">{label}</span>
      {detail ? <span className="fc-live-step__detail">{detail}</span> : null}
    </div>
  );
}

/** 경과 시간의 짧은 표기 — 초 단위, 분을 넘으면 m·s. 세 표면이 같은 자릿수로 센다. */
export function formatLiveElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
